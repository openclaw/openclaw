import { describe, expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { getAcpSessionResetControls } from "./manager.reset-controls.js";
import {
  AcpSessionManager,
  baseCfg,
  createRuntime,
  extractRuntimeOptionsFromUpserts,
  hoisted,
  installAcpSessionManagerTestLifecycle,
  installMutableAcpSessionMetaUpsert,
  type SessionAcpMeta,
} from "./manager.test-helpers.js";

const sessionKey = "agent:codex:acp:initialization";
const target = { cfg: baseCfg, sessionKey };
const input = { ...target, agent: "codex", mode: "persistent" as const };

function fixture() {
  const runtime = createRuntime();
  const state: { currentMeta: SessionAcpMeta | undefined } = { currentMeta: undefined };
  installMutableAcpSessionMetaUpsert(state);
  hoisted.requireAcpRuntimeBackendMock.mockReturnValue({ id: "acpx", runtime: runtime.runtime });
  hoisted.readAcpSessionEntryMock.mockImplementation(() => ({
    sessionKey,
    storeSessionKey: sessionKey,
    acp: state.currentMeta,
    entry: { sessionId: "initialization", updatedAt: 1, acp: state.currentMeta },
  }));
  return { ...runtime, state, manager: new AcpSessionManager() };
}

describe("AcpSessionManager initializeSession", () => {
  installAcpSessionManagerTestLifecycle();

  it("persists accepted runtime options while omitting dropped inherited thinking", async () => {
    const f = fixture();
    f.ensureSession.mockResolvedValueOnce({
      sessionKey,
      backend: "acpx",
      runtimeSessionName: "codex",
      appliedThinking: { kind: "dropped" },
    });
    const accepted = { model: "openai/gpt-5.4", cwd: "/workspace/from-runtime-options" };
    await f.manager.initializeSession({
      ...input,
      runtimeOptions: { ...accepted, thinking: "max" },
      thinkingExplicit: false,
    });
    expect(f.ensureSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey,
        ...accepted,
        thinking: "max",
        thinkingExplicit: false,
      }),
    );
    expect(extractRuntimeOptionsFromUpserts()).toEqual([accepted]);
    expect(f.state.currentMeta?.runtimeOptions).toEqual(accepted);
  });

  it("rolls back ensured runtime sessions when metadata persistence fails", async () => {
    const f = fixture();
    hoisted.upsertAcpSessionMetaMock.mockRejectedValueOnce(new Error("disk full"));
    await expect(f.manager.initializeSession(input)).rejects.toThrow("disk full");
    expect(f.close).toHaveBeenCalledWith({
      handle: expect.objectContaining({ sessionKey }),
      reason: "init-meta-failed",
    });
  });

  it("does not let reset-superseded initialization republish a stale runtime handle", async () => {
    const f = fixture();
    const entered = createDeferred();
    const release = createDeferred();
    let ensureCount = 0;
    f.ensureSession.mockImplementation(async () => {
      const callNumber = ++ensureCount;
      if (callNumber === 1) {
        entered.resolve();
        await release.promise;
      }
      return {
        sessionKey,
        backend: "acpx",
        runtimeSessionName: `runtime-${callNumber}`,
        backendSessionId: `backend-${callNumber}`,
      };
    });
    const stale = f.manager.initializeSession(input);
    const rejected = expect(stale).rejects.toMatchObject({
      code: "ACP_SESSION_INIT_FAILED",
      detailCode: "SESSION_ACTOR_SUPERSEDED",
    });
    await entered.promise;
    await getAcpSessionResetControls(f.manager).forceDiscardSessionRuntime({
      ...target,
      reason: "session-reset",
    });
    const fresh = await f.manager.initializeSession(input);
    expect(fresh.handle.runtimeSessionName).toBe("runtime-2");
    release.resolve();
    await rejected;
    expect(f.state.currentMeta?.runtimeSessionName).toBe("runtime-2");
    expect(f.close).toHaveBeenCalledWith({
      handle: expect.objectContaining({ runtimeSessionName: "runtime-1" }),
      reason: "session-actor-superseded",
      discardPersistentState: true,
    });
    await f.manager.runTurn({
      ...target,
      provenance: "system",
      text: "follow-up",
      mode: "prompt",
      requestId: "follow-up",
    });
    expect(ensureCount).toBe(2);
    expect(f.runTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        handle: expect.objectContaining({ runtimeSessionName: "runtime-2" }),
      }),
    );
  });
});
