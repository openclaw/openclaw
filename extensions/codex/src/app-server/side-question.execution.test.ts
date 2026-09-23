import "./side-question.test-support.js";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createAdmittedHostCapabilityTestFixture } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as clientCleanup from "./attempt-client-cleanup.js";
import { codexTestTurnIds } from "./codex-app-server.test-fixtures.js";
import { CodexEphemeralTurn } from "./ephemeral-turn.js";
import { CodexNativeToolLifecycleProjector } from "./event-projector-native-tool-lifecycle.js";
import { createCodexTestBindingStore } from "./session-binding.test-helpers.js";
import {
  createClientHarness,
  createCodexTestModel,
  useAutoCleanupTempDirTracker,
} from "./test-support.js";

const {
  getSharedCodexAppServerClientMock,
  retireSharedCodexAppServerClientIfCurrentMock,
  runCodexAppServerSideQuestion,
  runCodexAppServerSideQuestionImpl,
  createFakeClient,
  threadResult,
  turnStartResult,
  turnCompleted,
  sideParams,
  useSideQuestionTestSetup,
} = await import("./side-question.test-support.js");

describe("runCodexAppServerSideQuestion", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  useSideQuestionTestSetup();

  it("executes inherited Gateway shell tools through the side run's host authority", async () => {
    const workspaceDir = tempDirs.make("codex-side-gateway-shell-");
    const config = { tools: { exec: { host: "gateway" as const, mode: "full" as const } } };
    const runId = "side-gateway-shell";
    const sessionId = "side-gateway-session";
    const sessionKey = "agent:main:side-gateway-shell";
    const host = await createAdmittedHostCapabilityTestFixture({
      config,
      agentId: "main",
      sessionId,
      sessionKey,
      runId,
      workspaceDir,
      cwd: workspaceDir,
    });
    const turnStarted = createDeferred<void>();
    const client = createFakeClient({ completeTurn: false, onTurnStart: turnStarted.resolve });
    getSharedCodexAppServerClientMock.mockResolvedValue(client);
    const parent = { threadId: "parent-thread", cwd: workspaceDir, model: "gpt-5.5" };
    const run = runCodexAppServerSideQuestionImpl(
      sideParams({
        cfg: config,
        runtimeModel: createCodexTestModel("openai"),
        agentDir: workspaceDir,
        workspaceDir,
        sessionId,
        sessionKey,
        sessionEntry: {
          sessionId,
          updatedAt: 1,
          permissionMode: "full",
          sessionRoot: workspaceDir,
        },
        sandbox: null,
        hostCapabilities: host.hostCapabilities,
        opts: { runId },
      }),
      { bindingStore: { ...createCodexTestBindingStore(), read: () => parent } },
    );
    try {
      await Promise.race([
        turnStarted.promise,
        run.then(() => {
          throw new Error("Side question ended before accepting its turn");
        }),
      ]);
      const execResponse = await client.handleRequest({
        id: "side-gateway-exec",
        method: "item/tool/call",
        params: {
          ...codexTestTurnIds("side-thread"),
          callId: "side-gateway-exec",
          tool: "gateway_exec",
          arguments: { command: "printf codex-side-shell", workdir: workspaceDir },
        },
      });
      expect(execResponse).toMatchObject({ success: true });
      expect(JSON.stringify(execResponse)).toContain("codex-side-shell");
      const processResponse = await client.handleRequest({
        id: "side-gateway-process",
        method: "item/tool/call",
        params: {
          ...codexTestTurnIds("side-thread"),
          callId: "side-gateway-process",
          tool: "gateway_process",
          arguments: { action: "list" },
        },
      });
      expect(processResponse).toMatchObject({ success: true });
      client.emit(turnCompleted("side-thread", "turn-1", "Gateway shell inspected."));
      await expect(run).resolves.toEqual({ text: "Gateway shell inspected." });
    } finally {
      client.emit(turnCompleted("side-thread", "turn-1", "Gateway shell inspected."));
      await run.catch(() => {});
      host.closeHost();
      host.closeAdmission();
    }
  });

  it.each([
    { label: "after its request is written", written: true, interruptFails: false },
    { label: "before its request is written", written: false, interruptFails: false },
    {
      label: "when its native thread cannot unsubscribe",
      written: true,
      interruptFails: false,
      unsubscribeFails: true,
    },
    { label: "when its startup interrupt fails", written: true, interruptFails: true },
    {
      label: "when its startup interrupt fails with a retained peer",
      written: true,
      interruptFails: true,
      peerRetained: true,
    },
    {
      label: "when its startup interrupt and client retirement fail",
      written: true,
      interruptFails: true,
      retirementFails: true,
    },
  ])(
    "scopes side-turn abort cleanup $label",
    async ({ written, interruptFails, retirementFails, unsubscribeFails, peerRetained }) => {
      const controller = new AbortController();
      const harness = createClientHarness();
      const requests = vi.spyOn(harness.client, "request");
      if (peerRetained) {
        retireSharedCodexAppServerClientIfCurrentMock.mockReturnValueOnce({
          activeLeases: 2,
          closed: false,
        });
      }
      if (retirementFails) {
        vi.spyOn(harness.client, "closeAndWait").mockRejectedValueOnce(
          new Error("side client retirement failed"),
        );
      }
      getSharedCodexAppServerClientMock.mockResolvedValue(harness.client);
      const waitForRequest = async (method: string) =>
        await vi.waitFor(
          () => {
            const request = harness.writes
              .map((write) => JSON.parse(write) as { id: number; method: string; params: unknown })
              .find((message) => message.method === method);
            if (!request) {
              throw new Error(`Codex side harness did not write ${method}`);
            }
            return request;
          },
          { interval: 1, timeout: 5_000 },
        );
      const run = runCodexAppServerSideQuestion(
        sideParams({ opts: { abortSignal: controller.signal } }),
      );
      const failure = run.then(
        () => undefined,
        (error: unknown) => error,
      );
      const fork = await waitForRequest("thread/fork");
      harness.send({ id: fork.id, result: threadResult("side-thread") });
      const inject = await waitForRequest("thread/inject_items");
      harness.send({ id: inject.id, result: {} });

      if (written) {
        const turnStart = await waitForRequest("turn/start");
        controller.abort("side-start-cancelled");
        const interrupt = await waitForRequest("turn/interrupt");
        expect(interrupt.params).toEqual({ threadId: "side-thread", turnId: "" });
        harness.send({ id: turnStart.id, result: turnStartResult("turn-1") });
        harness.send(
          interruptFails
            ? { id: interrupt.id, error: { code: -32_000, message: "side interrupt failed" } }
            : { id: interrupt.id, result: {} },
        );
      } else {
        controller.abort("side-start-cancelled");
      }

      if (!interruptFails) {
        if (written) {
          const terminals = await waitForRequest("thread/backgroundTerminals/list");
          expect(terminals.params).toEqual({ threadId: "side-thread" });
          harness.send({ id: terminals.id, result: { data: [] } });
        }
        const unsubscribe = await waitForRequest("thread/unsubscribe");
        harness.send(
          unsubscribeFails
            ? { id: unsubscribe.id, error: { code: -32_000, message: "side unsubscribe failed" } }
            : { id: unsubscribe.id, result: {} },
        );
      }
      const error = await failure;
      if (written) {
        const turnStart =
          requests.mock.results[
            requests.mock.calls.findIndex(([method]) => method === "turn/start")
          ];
        if (turnStart?.type !== "return") {
          throw new Error("Expected the native turn/start request promise");
        }
        const primaryError = await turnStart.value.catch((reason: unknown) => reason);
        expect(primaryError).toMatchObject({
          message: "turn/start aborted: side-start-cancelled",
          cause: "side-start-cancelled",
          reason: "aborted",
          mayHaveWritten: true,
        });
        if (interruptFails) {
          expect(error).toBeInstanceOf(AggregateError);
          if (!(error instanceof AggregateError)) {
            throw new Error("Expected cancellation and native cleanup failures", { cause: error });
          }
          expect(error.cause).toBe(primaryError);
          expect(error.errors).toHaveLength(2);
          expect(error.errors[0]).toBe(primaryError);
          expect(error.errors[1]).toMatchObject({
            message:
              "Codex /btw cleanup could not confirm the side turn stopped; background terminals may still be running.",
          });
          expect(error.message).toContain("turn/start aborted: side-start-cancelled");
          expect(error.message).toContain("could not confirm the side turn stopped");
        } else {
          expect(error).toBe(primaryError);
        }
      } else {
        expect(error).toMatchObject({
          name: "CodexThreadPolicyHandoffError",
          outcome: "acknowledged",
          cause: "side-start-cancelled",
        });
      }
      expect(harness.writes.map((write) => JSON.parse(write).method)).toEqual([
        "thread/fork",
        "thread/inject_items",
        ...(written ? ["turn/start", "turn/interrupt"] : []),
        ...(written && !interruptFails ? ["thread/backgroundTerminals/list"] : []),
        ...(!interruptFails ? ["thread/unsubscribe"] : []),
      ]);
      expect(harness.stdinDestroyed).toBe(
        (interruptFails && !peerRetained) || unsubscribeFails === true,
      );
      if (peerRetained) {
        expect(retireSharedCodexAppServerClientIfCurrentMock).toHaveBeenCalledExactlyOnceWith(
          harness.client,
        );
      }
      harness.client.close();
    },
  );

  it.each([
    { terminationFails: false, projectorFails: false },
    { terminationFails: true, projectorFails: false },
    { terminationFails: true, projectorFails: true },
  ])(
    "settles side background-terminal cleanup before cancellation returns (terminal failure: $terminationFails, projector failure: $projectorFails)",
    async ({ terminationFails, projectorFails }) => {
      const controller = new AbortController();
      const client = createFakeClient({ completeTurn: false });
      const request = client.request.getMockImplementation()!;
      const turnWaiting = createDeferred<void>();
      const waits = vi.spyOn(CodexEphemeralTurn.prototype, "wait");
      CodexEphemeralTurn.prototype.wait = function (this: CodexEphemeralTurn, ...args) {
        const pending = waits.apply(this, args);
        turnWaiting.resolve();
        return pending;
      };
      const terminalCleanup = vi.spyOn(clientCleanup, "terminateCodexBackgroundTerminals");
      const finalize = vi.spyOn(CodexNativeToolLifecycleProjector.prototype, "finalizeActive");
      const projectorError = new Error("side projector finalization failed");
      if (projectorFails) {
        finalize.mockImplementationOnce(() => {
          throw projectorError;
        });
      }
      const releaseTermination = createDeferred<void>();
      const terminationStarted = createDeferred<void>();
      const terminals = new Map([
        ["parent-thread", new Set([10])],
        ["side-thread", new Set([20])],
      ]);
      client.request.mockImplementation(async (method, requestParams, requestOptions) => {
        if (method === "thread/backgroundTerminals/list") {
          const { threadId } = requestParams as { threadId: string };
          return { data: [...(terminals.get(threadId) ?? [])].map((processId) => ({ processId })) };
        }
        if (method === "thread/backgroundTerminals/terminate") {
          const { threadId, processId } = requestParams as { threadId: string; processId: number };
          terminationStarted.resolve();
          await releaseTermination.promise;
          if (!terminationFails) {
            terminals.get(threadId)?.delete(processId);
          }
          return { success: !terminationFails };
        }
        return await request(method, requestParams, requestOptions);
      });
      getSharedCodexAppServerClientMock.mockResolvedValue(client);
      let settled = false;
      const run = runCodexAppServerSideQuestion(
        sideParams({ opts: { abortSignal: controller.signal } }),
      )
        .catch((error: unknown) => error)
        .finally(() => {
          settled = true;
        });
      try {
        const waiting = await Promise.race([
          turnWaiting.promise.then(() => true),
          terminationStarted.promise.then(() => false),
          run.then(() => false),
        ]);
        if (!waiting) {
          // Cleanup can be waiting on our terminal gate before the run settles.
          releaseTermination.resolve();
          throw new Error("Side question settled before waiting for its native turn", {
            cause: await run,
          });
        }
        expect(client.request.mock.calls.some(([method]) => method === "turn/start")).toBe(true);
        controller.abort();
        await Promise.race([
          terminationStarted.promise,
          run.then((result) => {
            if (result instanceof Error) {
              throw result;
            }
            throw new Error("Side question settled before cancellation cleanup was ready", {
              cause: result,
            });
          }),
        ]);
        expect(client.request).toHaveBeenCalledWith(
          "thread/backgroundTerminals/terminate",
          { threadId: "side-thread", processId: 20 },
          expect.any(Object),
        );
        expect(settled).toBe(false);
        expect(client.request.mock.calls.some(([method]) => method === "thread/unsubscribe")).toBe(
          false,
        );
        releaseTermination.resolve();
        const error = await run;
        const wait = waits.mock.results[0];
        if (wait?.type !== "return") {
          throw new Error("Expected the native side-turn completion promise");
        }
        const primaryError = await wait.value.catch((reason: unknown) => reason);
        expect(primaryError).toMatchObject({ message: "Codex /btw was aborted." });
        if (terminationFails) {
          const cleanup = terminalCleanup.mock.results[0];
          if (cleanup?.type !== "return") {
            throw new Error("Expected the native terminal cleanup promise");
          }
          const cleanupError = await cleanup.value.catch((reason: unknown) => reason);
          expect(cleanupError).toMatchObject({
            message: expect.stringContaining("background-terminal cleanup failed"),
          });
          expect(error).toBeInstanceOf(AggregateError);
          if (!(error instanceof AggregateError)) {
            throw new Error("Expected cancellation and terminal cleanup failures", {
              cause: error,
            });
          }
          expect(error.cause).toBe(primaryError);
          expect(error.errors).toHaveLength(projectorFails ? 3 : 2);
          expect(error.errors[0]).toBe(primaryError);
          expect(error.errors[1]).toBe(cleanupError);
          expect(error.message).toContain("Codex /btw was aborted.");
          expect(error.message).toContain("background-terminal cleanup failed");
          if (projectorFails) {
            expect(error.errors[2]).toBe(projectorError);
            expect(error.message).toContain(projectorError.message);
          }
        } else {
          expect(error).toBe(primaryError);
        }
        expect(finalize).toHaveBeenCalledOnce();
        expect(terminals.get("parent-thread")).toEqual(new Set([10]));
        expect(terminals.get("side-thread")).toEqual(new Set(terminationFails ? [20] : []));
        expect(client.request.mock.calls.some(([method]) => method === "thread/unsubscribe")).toBe(
          !terminationFails,
        );
      } finally {
        releaseTermination.resolve();
        controller.abort();
        await run;
        waits.mockRestore();
        terminalCleanup.mockRestore();
        finalize.mockRestore();
      }
    },
  );
});
