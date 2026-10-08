import "../test-utils/prepare-compiled-subprocesses.js";
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, test, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import * as dispatch from "../auto-reply/dispatch.js";
import * as routedReplies from "../auto-reply/reply/route-reply.js";
import * as sessionEvents from "../auto-reply/reply/session-event-handoff.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { canRequesterAbortChatRun } from "../gateway/server-methods/chat-abort-authorization.js";
import { readExecRequestOwners, withExecRequestTurn } from "../infra/exec-request-context.js";
import {
  resolveSystemEventQueueKey,
  withSystemEventOwner,
} from "../infra/system-event-ownership.js";
import {
  enqueueSystemEventEntry,
  peekSystemEventEntries,
  resetSystemEventsForTest,
} from "../infra/system-events.js";
import { getProcessSupervisor } from "../process/supervisor/index.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import { captureExecRequestCancellation } from "./bash-process-control.js";
import {
  deleteSession,
  getFinishedSession,
  getSession,
  waitForExecScope,
  type ProcessSession,
} from "./bash-process-registry.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { createExecTool } from "./bash-tools.exec-run.js";
import type { RunEmbeddedAgentParams } from "./embedded-agent-runner/run/params.js";
import { runEmbeddedAgent } from "./embedded-agent.js";

// mock-isolation: Only model inference is synthetic; Stop, reply admission and processes are real.
vi.mock("./embedded-agent-runner/run.js", () => ({ runEmbeddedAgent: vi.fn() }));
const model = vi.mocked(runEmbeddedAgent);
await import("../auto-reply/reply/get-reply-from-config.runtime.js").then((runtime) =>
  runtime.prewarmConfigDrivenReplyRuntime(),
);

function nodeCommand(source: string): string {
  const quote = (value: string) =>
    `'${value.replaceAll("'", process.platform === "win32" ? "''" : "'\\''")}'`;
  const command = `${quote(process.execPath)} -e ${quote(source)}`;
  return process.platform === "win32" ? `& ${command}` : command;
}

test.for([
  { sessionScope: "per-sender", stopAt: "origin" },
  { sessionScope: "global", stopAt: "origin" },
  { sessionScope: "per-sender", stopAt: "active destination" },
] as const)(
  "stops the ordinary $sessionScope completion from $stopAt after process-record eviction",
  async ({ sessionScope, stopAt }, { signal, onTestFinished }) => {
    const work = withOpenClawTestState(
      { label: "ordinary-exec-request-stop", env: { OPENCLAW_TEST_FAST: "0" } },
      async (state) => {
        const directory = state.workspaceDir;
        await fs.mkdir(directory, { recursive: true });
        const releasePath = path.join(directory, "release");
        const origin = {
          runId: `routed-request-${sessionScope}`,
          sessionKey: "agent:main:telegram:direct:owner",
          sessionId: `routed-session-${sessionScope}`,
          agentId: "main",
          ownerDeviceId: "origin-device",
        };
        const destination = sessionScope === "global" ? "global" : "agent:main:main";
        const destinationQueue = resolveSystemEventQueueKey(destination, "main");
        const continuation = {
          runId: "routed-continuation-run",
          sessionKey: destination,
          sessionId: "routed-continuation-session",
          agentId: "main",
        };
        const continuationScope = `routed-continuation:${sessionScope}`;
        const config: OpenClawConfig = {
          agents: {
            entries: { main: { workspace: directory } },
            defaults: {
              workspace: directory,
              skipBootstrap: true,
              model: { primary: "mock-openai/gpt-5.6-luna" },
              models: { "mock-openai/gpt-5.6-luna": { agentRuntime: { id: "openclaw" } } },
            },
          },
          session: { scope: sessionScope },
          plugins: { enabled: false },
          skills: { load: { watch: false } },
        };
        setRuntimeConfigSnapshot(config);
        await state.writeConfig(config);
        openOpenClawStateDatabase();
        await replaceSessionEntry(continuation, {
          sessionId: continuation.sessionId,
          lifecycleRevision: "original",
          updatedAt: Date.now(),
          sessionStartedAt: Date.now(),
          permissionMode: "full",
          delivery: normalizeSessionDeliveryState({
            context: { channel: "telegram", to: "synthetic-stop-target" },
          }),
        });
        const entered = createDeferred();
        const releaseModel = createDeferred();
        const completionCreated =
          createDeferred<ReturnType<typeof sessionEvents.enqueueSessionEventForHost>>();
        const enqueue = sessionEvents.enqueueSessionEventForHost;
        const observe = vi
          .spyOn(sessionEvents, "enqueueSessionEventForHost")
          .mockImplementation((text, options) => {
            const receipt = enqueue(text, options);
            if (options.source === "exec") {
              completionCreated.resolve(receipt);
            }
            return receipt;
          });
        const send = vi
          .spyOn(routedReplies, "routeReply")
          .mockResolvedValue({ ok: true, delivered: true });
        const dispatchActual = dispatch.dispatchInboundMessageWithRoutedChannelDispatcher;
        // Model the Gateway's admitted destination actor scope, without replacing reply execution.
        const admittedDestination = vi
          .spyOn(dispatch, "dispatchInboundMessageWithRoutedChannelDispatcher")
          .mockImplementation((params) =>
            stopAt === "active destination" && params.ctx.InternalTurnSource === "event"
              ? withExecRequestTurn(
                  { identity: { ...continuation, ownerDeviceId: "destination-device" } },
                  () =>
                    dispatchActual({
                      ...params,
                      replyOptions: { ...params.replyOptions, runId: continuation.runId },
                    }),
                )
              : dispatchActual(params),
          );
        let continuedProcess: ProcessSession | undefined;
        let continuationRuns = 0;
        model.mockReset().mockImplementation(async (params: RunEmbeddedAgentParams) => {
          const admission = expectDefined(params.preparedRunAdmission, "ordinary reply admission");
          await admission.admit("gateway", params.runId);
          params.onExecutionPhase?.({ phase: "model_call_started" });
          await params.onExecutionStarted?.();
          await params.onAgentEvent?.({ stream: "lifecycle", data: { phase: "start" } });
          if (params.prompt.includes("Later human request")) {
            return {
              payloads: [{ text: "Later human request succeeded" }],
              meta: { durationMs: 0 },
            };
          }
          if (params.prompt.includes("ROUTED_REQUEST_COMPLETE")) {
            continuationRuns += 1;
            const exec = createExecTool({
              config,
              runId: params.runId,
              sessionKey: params.sessionKey,
              sessionId: params.sessionId,
              agentId: params.agentId,
              host: "gateway",
              security: "full",
              ask: "off",
              cwd: directory,
              scopeKey: continuationScope,
              allowBackground: true,
              notifyOnExit: true,
            });
            const running = await exec.execute("routed-continuation", {
              command: nodeCommand('require("node:fs").watch(".", () => {})'),
              yieldMs: 10,
              timeoutSeconds: 60,
            });
            expect(running.details.status).toBe("running");
            if (running.details.status !== "running") {
              throw new Error("Expected the destination continuation's ordinary command");
            }
            continuedProcess = expectDefined(
              getSession(running.details.sessionId),
              "continued process",
            );
          }
          entered.resolve();
          await releaseModel.promise;
          return {
            payloads: [
              {
                text: params.prompt.includes("ROUTED_REQUEST_COMPLETE")
                  ? "Late completion must not send"
                  : "NO_REPLY",
              },
            ],
            meta: { durationMs: 0 },
          };
        });
        let predecessor: ReturnType<typeof enqueue> | undefined;
        let completion: ReturnType<typeof enqueue> | undefined;
        const onAbort = () => releaseModel.resolve();
        signal.addEventListener("abort", onAbort, { once: true });
        try {
          if (stopAt === "origin") {
            predecessor = enqueue("Hold the predecessor", {
              agentId: "main",
              sessionKey: destination,
              source: "task",
              deliver: false,
              abortSignal: signal,
            });
            await expect(predecessor.accepted).resolves.toEqual({ ok: true });
            await withinTest(entered.promise, signal);
          }
          const command = nodeCommand(`
            const fs = require("node:fs");
            let done = false;
            const finish = () => {
              if (!done && fs.existsSync(${JSON.stringify(releasePath)})) {
                done = true; watcher.close(); process.stdout.write("ROUTED_REQUEST_COMPLETE");
              }
            };
            const watcher = fs.watch(${JSON.stringify(directory)}, finish);
            finish();
          `);
          const started = await withExecRequestTurn({ identity: origin }, async () => {
            const exec = createExecTool({
              ...origin,
              config,
              host: "gateway",
              security: "full",
              ask: "off",
              cwd: directory,
              scopeKey: origin.sessionKey,
              allowBackground: true,
              notifyOnExit: true,
              eventRouting: { sessionScope, dmScope: "main", allowFrom: ["owner"] },
            });
            return exec.execute("routed-completion", { command, yieldMs: 10, timeoutSeconds: 60 });
          });
          expect(started.details.status).toBe("running");
          if (started.details.status !== "running") {
            throw new Error("Expected an ordinary yielded command");
          }
          await fs.writeFile(releasePath, "release");
          await waitForExecScope(origin.sessionKey);
          expect(getFinishedSession(started.details.sessionId)?.exitCode).toBe(0);
          completion = await withinTest(completionCreated.promise, signal);
          await expect(completion.accepted).resolves.toEqual({ ok: true });
          deleteSession(started.details.sessionId);
          expect(getFinishedSession(started.details.sessionId)).toBeUndefined();
          const neighbor = expectDefined(
            enqueueSystemEventEntry(
              "Unrelated queued reminder",
              withSystemEventOwner({ sessionKey: destination }, "main"),
            ),
            "neighbor occurrence",
          );
          if (stopAt === "active destination") {
            await withinTest(entered.promise, signal);
            const capture = (deviceId: string) =>
              captureExecRequestCancellation(continuation, (identity) =>
                canRequesterAbortChatRun(identity, { deviceId, isAdmin: false }),
              );
            const denied = capture("foreign-device");
            expect(denied.cancel()).toBe(false);
            await denied.settle();
            expect(continuedProcess?.exited).toBe(false);
            expect(continuedProcess?.cancellationRequested).not.toBe(true);
            const cancellation = capture("destination-device");
            expect(cancellation.cancel()).toBe(true);
            await cancellation.settle();
            expect(continuedProcess).toMatchObject({ exited: true, exitReason: "manual-cancel" });
            expect(continuedProcess?.finalizationFailed).not.toBe(true);
            expect(continuedProcess?.cleanupUncertain).not.toBe(true);
          } else {
            const routed = peekSystemEventEntries(destinationQueue).filter((event) =>
              event.text.includes("ROUTED_REQUEST_COMPLETE"),
            );
            expect(routed).toHaveLength(1);
            expect(readExecRequestOwners(routed[0]!)).toHaveLength(1);
            const denied = captureExecRequestCancellation(origin, (identity) =>
              canRequesterAbortChatRun(identity, { deviceId: "foreign-device", isAdmin: false }),
            );
            expect(denied.cancel()).toBe(false);
            await denied.settle();
            const cancellation = captureExecRequestCancellation(origin, (identity) =>
              canRequesterAbortChatRun(identity, { deviceId: "origin-device", isAdmin: false }),
            );
            expect(cancellation.cancel()).toBe(true);
            await cancellation.settle();
          }
          releaseModel.resolve();
          await Promise.all([completion.settled, predecessor?.settled]);
          expect(await completion.settled).toMatchObject({ status: "cancelled", delivered: false });
          expect(continuationRuns).toBe(stopAt === "origin" ? 0 : 1);
          expect(send).not.toHaveBeenCalled();
          expect(peekSystemEventEntries(destinationQueue)).toEqual([neighbor]);
          expect(peekSystemEventEntries(origin.sessionKey)).toEqual([]);
          const laterDelivery = vi.fn(async () => {});
          await dispatchActual({
            cfg: config,
            ctx: {
              AgentId: "main",
              SessionKey: destination,
              Body: "Later human request",
              Provider: "webchat",
              Surface: "webchat",
              CommandAuthorized: true,
            },
            dispatcherOptions: { deliver: laterDelivery },
          });
          expect(laterDelivery).toHaveBeenCalledWith(
            expect.objectContaining({ text: "Later human request succeeded" }),
            expect.anything(),
          );
          expect(continuationRuns).toBe(stopAt === "origin" ? 0 : 1);
          expect(send).not.toHaveBeenCalled();
        } finally {
          releaseModel.resolve();
          await fs.writeFile(releasePath, "release");
          getProcessSupervisor().cancelScope(origin.sessionKey, "manual-cancel");
          getProcessSupervisor().cancelScope(continuationScope, "manual-cancel");
          await Promise.all([
            waitForExecScope(origin.sessionKey),
            waitForExecScope(continuationScope),
          ]);
          await Promise.allSettled([completion?.settled, predecessor?.settled]);
          signal.removeEventListener("abort", onAbort);
          observe.mockRestore();
          send.mockRestore();
          admittedDestination.mockRestore();
          resetProcessRegistryForTests();
          resetSystemEventsForTest();
        }
      },
    );
    onTestFinished(async () => {
      await Promise.allSettled([work]);
    });
    await work;
  },
);
