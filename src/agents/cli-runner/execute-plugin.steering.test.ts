import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { runActiveReplySteer } from "../../auto-reply/reply/agent-runner-steer-adoption.js";
import { handleSteerCommand } from "../../auto-reply/reply/commands-steer.js";
import { buildCommandTestParams } from "../../auto-reply/reply/commands.test-harness.js";
import { createQueueTestRun } from "../../auto-reply/reply/queue.test-helpers.js";
import { resolveQueueSettingsCore } from "../../auto-reply/reply/queue/settings.js";
import { clearFollowupQueue } from "../../auto-reply/reply/queue/state.js";
import type { ReplyOperationRunState } from "../../auto-reply/reply/reply-operation-run-state.js";
import { prepareReplyToolAuthority } from "../../auto-reply/reply/reply-tool-authority.js";
import { resolveFollowupRunToolAuthorityFingerprintAsync } from "../../auto-reply/reply/reply-tool-authority.test-support.js";
import { createMockTypingController } from "../../auto-reply/reply/test-helpers.js";
import { createTypingSignaler } from "../../auto-reply/reply/typing-mode.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import {
  updateSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import * as sessionReads from "../../config/sessions/session-entry-read-runtime.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { CliBackendPlugin } from "../../plugins/cli-backend.types.js";
import {
  beginReplyMessageInjectionTarget,
  captureCurrentReplyMessageInjectionTarget,
} from "../../sessions/session-controller.message-injection.js";
import { createReplyOperation } from "../../sessions/session-controller.operation.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import {
  createTestUserTurnTranscriptTarget,
  readTranscriptMessages,
} from "../../sessions/user-turn-transcript.test-support.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  bindWorkerToolPreparation,
  prepareReplyToolAuthorityCallerRead,
} from "../harness/host-private-capabilities.js";
import { bindPreparedToolAuthority } from "../harness/tool-authority-preparation.js";
import { executePluginOwnedProcess } from "./execute-plugin.js";
import { closePluginTestAdmissions, createExecution } from "./execute-plugin.test-support.js";

const { buildAnthropicCliBackend } = await loadBundledPluginFacade<{
  buildAnthropicCliBackend: () => CliBackendPlugin;
}>({ pluginId: "anthropic", artifactBasename: "api.js" });

// One external process proves stdin delivery through the real public provider adapter.
// Native scheduling variants belong to the Anthropic transport's protocol matrix.
const CLI = String.raw`
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const send = value => process.stdout.write(JSON.stringify(value) + "\n");
const inputs = new Map();
let initial = true;
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.type === "control_request") {
    send({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: {} } });
  } else if (message.type === "user") {
    const text = message.message.content;
    appendFileSync("received.ndjson", JSON.stringify(text) + "\n");
    inputs.set(message.uuid, { text, initial });
    if (initial) send({ type: "system", subtype: "init", capabilities: ["msg_lifecycle_v1"] });
    send({ type: "command_lifecycle", state: "started", command_uuid: message.uuid });
    send({ type: "control_request", request_id: message.uuid, request: {
      subtype: "hook_callback", callback_id: "UserPromptSubmit",
      input: { hook_event_name: "UserPromptSubmit", prompt: text },
    } });
    initial = false;
  } else if (message.type === "control_response") {
    const input = inputs.get(message.response.request_id);
    if (!input) continue;
    if (input.text === "started-exit") process.exit(1);
    if (!input.initial) send({ type: "command_lifecycle", state: input.text === "started-cancelled" ? "cancelled" : "completed", command_uuid: message.response.request_id });
    send({ type: "system", subtype: "fixture_input", text: input.text });
    if (input.text === "finish") send({ type: "result", subtype: "success", is_error: false, result: "finished" });
  }
}
`;

afterEach(() => {
  closePluginTestAdmissions();
  clearRuntimeConfigSnapshot();
  vi.restoreAllMocks();
});

it("steers configured, session and explicit inputs through current authority into Claude stdin", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const root = state.workspaceDir;
    const sessionKey = "agent:main:main";
    const policyKey = "agent:main:claude-steering-policy";
    const config: OpenClawConfig = {
      commands: { text: true },
      agents: { defaults: { sandbox: { mode: "all" } }, entries: { main: {} } },
      tools: { sandbox: { tools: { deny: ["exec"] } }, exec: { security: "full", ask: "off" } },
    };
    // Storage consumes the runtime-prepared config, including in a fresh Bun worker.
    setRuntimeConfigSnapshot(config);
    const policyScope = { agentId: "main", sessionKey: policyKey };
    await upsertSessionEntryCore(policyScope, {
      sessionId: "policy",
      updatedAt: 1,
      sandboxMode: "off",
    });
    const { context } = await createExecution({ config, timeoutMs: 30_000 });
    const { params } = context;
    const { sessionId } = params;
    Object.assign(params, {
      sessionKey,
      runtimePolicySessionKey: policyKey,
      workspaceDir: root,
      cwd: root,
      messageProvider: "webchat",
      senderId: "owner",
      senderIsOwner: true,
      traceAuthorized: false,
    });
    let rejectSourceCleanup = false;
    params.assertCurrent = Object.assign(() => {}, {
      prepareSessionSourceScope: async () => ({
        checks: [],
        assertCurrent: () => {},
        release: () => {
          if (rejectSourceCleanup) {
            throw new Error("Source scope cleanup failed after stdin submission");
          }
        },
      }),
    });
    context.workspaceDir = root;
    context.cwd = root;
    const recordInput = (text: string) =>
      createUserTurnTranscriptRecorder({
        input: { text, idempotencyKey: text },
        target: createTestUserTurnTranscriptTarget({ sessionKey, sessionId, cwd: root }),
      });
    const followupRun = createQueueTestRun({ prompt: "initial", originatingChannel: "webchat" });
    Object.assign(followupRun.run, params);
    const operation = createReplyOperation({ sessionKey, sessionId, resetTriggered: false });
    await operation.bindToolAuthoritySnapshotAsync(prepareReplyToolAuthority(followupRun));
    const fingerprint = await operation.bindToolAuthorityRouteAsync(followupRun.run);
    Object.assign(params, { toolAuthorityFingerprint: fingerprint, replyOperation: operation });
    operation.setPhase("running");
    const fixture = path.join(root, "claude-steering.mjs");
    await writeFile(fixture, CLI);
    const prepared = await buildAnthropicCliBackend().prepareExecution?.({
      workspaceDir: root,
      provider: "claude-cli",
      modelId: context.normalizedModel,
      executionMode: "agent",
      config,
    });
    const execute = expectDefined(prepared?.execute, "Claude native transport");
    const ready = createDeferred();
    const cleanupInputObserved = createDeferred();
    const observations = new Map([
      ["initial", ready],
      ["post-submit-cleanup", cleanupInputObserved],
    ]);
    const run = executePluginOwnedProcess({
      context,
      execute,
      executionCommand: process.execPath,
      executionArgs: [fixture],
      env: { PATH: process.env.PATH ?? "", HOME: root, CLAUDE_CONFIG_DIR: root },
      prompt: "initial",
      useResume: false,
      noOutputTimeoutMs: 30_000,
      consumeStdout: (chunk) => {
        const record = JSON.parse(chunk);
        if (record.subtype === "fixture_input") {
          observations.get(record.text)?.resolve();
        }
      },
    });
    const settled = run.catch((error: unknown) => error);
    const readInputs = async () =>
      (await readFile(path.join(root, "received.ndjson"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    try {
      await Promise.race([
        ready.promise,
        run.then(() => {
          throw new Error("Native turn ended before readiness");
        }),
      ]);
      const target = expectDefined(
        captureCurrentReplyMessageInjectionTarget(sessionKey),
        "Claude registry input sink",
      );
      const guestFingerprint = await resolveFollowupRunToolAuthorityFingerprintAsync({
        ...followupRun,
        toolsAllow: ["read"],
        run: { ...followupRun.run, senderId: "guest", senderIsOwner: false },
      });
      expect(guestFingerprint).not.toBe(fingerprint);
      const mismatch = await beginReplyMessageInjectionTarget(target, "different principal", {
        isInboundUserMessage: true,
        toolAuthorityFingerprint: guestFingerprint,
      });
      await expect(mismatch.outcome).resolves.toMatchObject({
        status: "rejected",
        reason: "tool_authority_mismatch",
      });
      expect(await readInputs()).toEqual(["initial"]);

      const typing = createMockTypingController();
      const followup = vi.fn(async () => {});
      const routes = [
        { text: "global", queue: { mode: "steer" as const } },
        {
          text: "channel",
          queue: { mode: "followup" as const, byChannel: { webchat: "steer" as const } },
        },
        { text: "session", queue: { mode: "collect" as const }, sessionMode: "steer" as const },
        { text: "explicit steer", queue: { mode: "followup" as const }, command: "/steer" },
        { text: "explicit tell", queue: { mode: "collect" as const }, command: "/tell" },
        { text: "started-cancelled", queue: { mode: "steer" as const } },
      ];
      const routeInputs = routes.map((route) => route.text);
      const webchatContext = { Provider: "webchat", Surface: "webchat", SessionKey: sessionKey };
      for (const route of routes) {
        const cfg = { ...config, messages: { queue: route.queue } };
        let inlineMode: "steer" | undefined;
        if (route.command) {
          const commandParams = buildCommandTestParams(
            route.command + " " + route.text,
            cfg,
            webchatContext,
            { workspaceDir: root },
          );
          const result = await handleSteerCommand(commandParams, true);
          expect(result).toMatchObject({ shouldContinue: true, queueModeOverride: "steer" });
          expect(commandParams.ctx.BodyForAgent).toBe(route.text);
          inlineMode = result?.queueModeOverride === "steer" ? "steer" : undefined;
        }
        const resolvedQueue = resolveQueueSettingsCore({
          cfg,
          channel: "webchat",
          inlineMode,
          sessionEntry: route.sessionMode
            ? { sessionId, updatedAt: 1, queueMode: route.sessionMode }
            : undefined,
        });
        expect(resolvedQueue.mode).toBe("steer");
        const recorder = recordInput(route.text);
        const incoming = {
          ...followupRun,
          prompt: route.text,
          messageId: route.text,
          userTurnTranscriptRecorder: recorder,
        };
        const resultState: ReplyOperationRunState = {};
        await expect(
          runActiveReplySteer({
            followupRun: incoming,
            opts: { runId: route.text },
            providedReplyOperation: operation,
            queueKey: sessionKey,
            replyOperationRunState: resultState,
            resolvedQueue,
            restartRecoverySourceTurnId: undefined,
            runFollowup: followup,
            sessionCtx: {},
            sessionKey,
            touchActiveSessionEntry: async () => {},
            typingSignals: createTypingSignaler({ typing, mode: "never" }),
          }),
        ).resolves.toBe("handled");
        expect(resultState.admission).toEqual({ status: "accepted", mode: "steer" });
        expect(recorder.hasPersisted()).toBe(true);
      }
      expect(followup).not.toHaveBeenCalled();
      expect(await readInputs()).toEqual(["initial", ...routeInputs]);

      // Revoke stored policy after selection but before the ordered final worker read.
      const read = sessionReads.withSessionEntriesFromStoresInWorker;
      let revoked = false;
      vi.spyOn(sessionReads, "withSessionEntriesFromStoresInWorker").mockImplementation(
        async (inputs, consume, options) => {
          if (options?.ordered && !revoked) {
            revoked = true;
            await updateSessionEntry(policyScope, () => ({ sandboxMode: undefined }));
          }
          return read(inputs, consume, options);
        },
      );
      const assertCurrent = () => operation.abortSignal.throwIfAborted();
      const refused = await beginReplyMessageInjectionTarget(target, "revoked policy", {
        isInboundUserMessage: true,
        toolAuthorityFingerprint: fingerprint,
        toolAuthorityPreparation: bindPreparedToolAuthority(
          bindWorkerToolPreparation({
            assertCurrent,
            compatAssertCurrent: () => {
              throw new Error("Expected worker-prepared Claude input");
            },
            prepareCurrent: async () => {
              const authorityRead = expectDefined(
                await prepareReplyToolAuthorityCallerRead(
                  operation.projectToolAuthorityFingerprintAsync,
                  undefined,
                  fingerprint,
                  followupRun.run,
                  assertCurrent,
                ),
                "worker-prepared Claude input policy",
              );
              await authorityRead.prepareCurrent();
            },
          }),
        ),
      });
      await expect(refused.acceptance).resolves.toBe(false);
      const refusal = await refused.outcome;
      expect(revoked, JSON.stringify(refusal)).toBe(true);
      // Changed execution policy leaves unconsumed input eligible for a fresh followup.
      expect(refusal).toMatchObject({ status: "rejected", reason: "tool_authority_mismatch" });
      expect(await readInputs()).toEqual(["initial", ...routeInputs]);
      vi.restoreAllMocks();
      rejectSourceCleanup = true;
      const uncertain = await beginReplyMessageInjectionTarget(target, "post-submit-cleanup");
      await expect(uncertain.acceptance).resolves.toBe(true);
      await expect(uncertain.outcome).resolves.toMatchObject({ status: "indeterminate" });
      rejectSourceCleanup = false;
      await cleanupInputObserved.promise;
      const exitRecorder = recordInput("started-exit");
      const exit = await beginReplyMessageInjectionTarget(target, "started-exit", {
        userTurnTranscriptRecorder: exitRecorder,
      });
      await expect(exit.acceptance).resolves.toBe(true);
      await expect(exit.outcome).resolves.toMatchObject({ status: "accepted" });
      await expect(run).rejects.toThrow();
      const expectedInputs = [...routeInputs, "started-exit"];
      expect(await readInputs()).toEqual([
        "initial",
        ...routeInputs,
        "post-submit-cleanup",
        "started-exit",
      ]);
      expect(exitRecorder.hasPersisted()).toBe(true);
      const messages = await readTranscriptMessages({
        sessionId,
        sessionKey,
        storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
      });
      expect(messages.map((message) => message.content)).toEqual(expectedInputs);
      expect(followup).not.toHaveBeenCalled();
    } finally {
      operation.abortByUser();
      await settled;
      operation.complete();
      clearFollowupQueue(sessionKey);
      await prepared?.cleanup?.();
    }
  });
});
