import { getEventListeners } from "node:events";
import { expectDefined } from "@openclaw/normalization-core/expect";
import type { AgentHarnessAttemptParamsV2 } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { expect, it, vi } from "vitest";
import { copilotAttemptOverrides } from "./attempt-selectors.test-support.js";
import * as copilot from "./attempt.test-support.js";
import * as byokProxy from "./byok-proxy.js";

type Params = AgentHarnessAttemptParamsV2;

export function registerCopilotCleanupTests({
  makeParams,
  requireSession,
}: {
  makeParams: (overrides?: Pick<Params, "onAgentEvent">) => Params;
  requireSession: (sdk: copilot.FakeSdk) => copilot.FakeSession;
}) {
  const run = (
    params: Parameters<typeof copilot.runCopilotAttempt>[0],
    pool: ReturnType<typeof copilot.makeFakePool>,
  ) => copilot.runCopilotAttempt(params, { pool });
  it("joins detached background compaction before deleting its fresh native session", async () => {
    const compacted = copilot.createAttemptGate();
    const sdk = copilot.makeFakeSdk((session) => {
      session.sendAndWait.mockImplementationOnce(async () => {
        session.emit("user.message", { content: "hello" });
        session.emit("session.compaction_start", {});
        void compacted.wait().then(() => {
          session.emit("session.compaction_complete", { success: true });
          session.emit("session.idle", {});
        });
        return copilot.makeAssistantMessageEvent("done");
      });
    });
    const pool = copilot.makeFakePool(sdk);
    const attempt = run({ ...makeParams(), sessionPersistence: "detached" }, pool);
    try {
      await copilot.awaitAttemptStage(compacted.entered, attempt);
      expect(sdk.client.deleteSession).not.toHaveBeenCalled();
      expect(pool.release).not.toHaveBeenCalled();
    } finally {
      compacted.release();
    }
    expect((await attempt).terminal.kind).toBe("ok");
    expect(requireSession(sdk).disconnect).toHaveBeenCalledOnce();
    expect(sdk.client.deleteSession).toHaveBeenCalledWith(requireSession(sdk).sessionId);
    expect(pool.release).toHaveBeenCalledOnce();
  });

  it("preserves the primary failure when detached native deletion also fails", async () => {
    const primary = new Error("synthetic send failure");
    const cleanupFailure = new Error("synthetic deletion failure");
    const sdk = copilot.makeFakeSdk((session) => {
      session.sendAndWait.mockRejectedValueOnce(primary);
    });
    sdk.client.deleteSession.mockRejectedValueOnce(cleanupFailure);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const pool = copilot.makeFakePool(sdk);
    const result = await run({ ...makeParams(), sessionPersistence: "detached" }, pool);
    const { promptError } = copilot.projectAgentRunAttemptTerminal(result.terminal);
    expect(promptError).toBe(primary);
    expect(warning.mock.calls[0]?.[1]).toBe(cleanupFailure);
    expect(pool.release).toHaveBeenCalledOnce();
  });

  it.each(["auth", "proxy"] as const)("cleans up pre-session %s failures", async (stage) => {
    const controller = new AbortController();
    const callerAbort = vi.fn();
    controller.signal.addEventListener("abort", callerAbort);
    const pool = copilot.makeFakePool(copilot.makeFakeSdk());
    const base = { ...makeParams(), abortSignal: controller.signal };
    copilotAttemptOverrides.resolveSandboxContext = async () => null;
    try {
      if (stage === "auth") {
        const auth = { useLoggedInUser: false, gitHubToken: "synthetic-token" };
        const invalidAuth = { ...base, auth } satisfies Params &
          Pick<import("./attempt-types.js").AttemptParamsLike, "auth">;
        await expect(run(invalidAuth, pool)).rejects.toThrow(
          "gitHubToken auth requires profileId+profileVersion",
        );
      } else {
        const failure = new Error("synthetic proxy startup failure");
        vi.spyOn(byokProxy, "createCopilotByokProxy").mockRejectedValueOnce(failure);
        const provider = "custom-openai";
        const model = { ...base.model, provider, baseUrl: "https://api.example.test/v1" };
        const result = await run(
          {
            ...base,
            model,
            resolvedApiKey: "synthetic-token",
            authProfileId: "custom-openai:main",
          },
          pool,
        );
        const { promptError } = copilot.projectAgentRunAttemptTerminal(result.terminal);
        expect(promptError).toMatchObject({ code: "model_not_supported", cause: failure });
      }
      expect(pool.acquire).not.toHaveBeenCalled();
      expect(getEventListeners(controller.signal, "abort")).toEqual([callerAbort]);
    } finally {
      controller.abort();
    }
    expect(callerAbort).toHaveBeenCalledOnce();
  });

  it("keeps cancellation raised during pre-session preparation", async () => {
    const controller = new AbortController();
    const sandbox = copilot.createAttemptGate<null>();
    const sdk = copilot.makeFakeSdk();
    copilotAttemptOverrides.resolveSandboxContext = sandbox.wait;
    const attempt = run(
      { ...makeParams(), abortSignal: controller.signal },
      copilot.makeFakePool(sdk),
    );
    try {
      await copilot.awaitAttemptStage(sandbox.entered, attempt);
      controller.abort();
      sandbox.release(null);
      const result = await attempt;
      expect(result.terminal).toMatchObject({ kind: "aborted", source: "external" });
      expect(sdk.sessions.flatMap((session) => session.sendAndWait.mock.calls)).toEqual([]);
      expect(getEventListeners(controller.signal, "abort")).toEqual([]);
    } finally {
      controller.abort();
      sandbox.release(null);
      await attempt;
    }
  });

  it.each([false, true])("joins callbacks before cleanup (deferred: %s)", async (deferred) => {
    const callback = copilot.createAttemptGate();
    const listenersDetached = createDeferred<void>();
    const sendFailure = new Error("send failed after an accepted agent event");
    const onAgentEvent = vi.fn(callback.wait);
    const sdk = copilot.makeFakeSdk((session) => {
      const off = expectDefined(session.off.getMockImplementation(), "session unsubscribe");
      session.off.mockImplementationOnce((...args) => {
        off(...args);
        listenersDetached.resolve();
      });
      session.sendAndWait.mockImplementationOnce(async () => {
        session.emit("user.message", { content: "hello" });
        if (deferred) {
          session.emit("session.compaction_start", {});
          return copilot.makeAssistantMessageEvent("done");
        }
        session.emit("session.plan_changed", { operation: "update" });
        throw sendFailure;
      });
    });
    const pool = copilot.makeFakePool(sdk);
    const onDeferredCompaction = vi.fn<(params: { cleanup: Promise<unknown> }) => void>();
    const params = makeParams({ onAgentEvent });
    const attempt = copilot.runCopilotAttempt(params, { pool, onDeferredCompaction });
    let cleanup: Promise<unknown> = attempt;
    try {
      if (deferred) {
        expect((await attempt).terminal).toEqual({ kind: "ok" });
        const deferredState = onDeferredCompaction.mock.calls[0]?.[0];
        cleanup = expectDefined(deferredState?.cleanup, "deferred cleanup");
        const session = requireSession(sdk);
        session.emit("session.plan_changed", { operation: "update" });
        session.emit("session.compaction_complete", { success: true });
        session.emit("session.idle", {});
      }
      await callback.entered;
      await listenersDetached.promise;
      const session = requireSession(sdk);
      expect(session.off).toHaveBeenCalledTimes(session.on.mock.calls.length);
      expect(session.disconnect).not.toHaveBeenCalled();
      expect(pool.release).not.toHaveBeenCalled();
      session.emit("session.plan_changed", { operation: "update" });
    } finally {
      callback.release();
      await cleanup;
    }
    expect(onAgentEvent).toHaveBeenCalledOnce();
    expect(requireSession(sdk).disconnect).toHaveBeenCalledOnce();
    expect(pool.release).toHaveBeenCalledOnce();
    if (!deferred) {
      const { promptError } = copilot.projectAgentRunAttemptTerminal((await attempt).terminal);
      expect(promptError).toBe(sendFailure);
    }
  });
}
