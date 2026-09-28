import { describe, expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  AcpSessionManager,
  baseCfg,
  createRuntime,
  disposeAcpSessionManagerInstance,
  hoisted,
  installAcpSessionManagerTestLifecycle,
  readySessionMeta,
} from "./manager.test-helpers.js";

describe("ACP close target custody", () => {
  installAcpSessionManagerTestLifecycle();

  it("captures the expected owner before waiting for the session actor", async () => {
    const sessionKey = "agent:main:acp:close-wait";
    const state = createRuntime();
    const meta = readySessionMeta({ agent: "main" });
    let entry = {
      sessionId: "original",
      lifecycleRevision: "original",
      updatedAt: 1,
      spawnedBy: "agent:main:original-owner",
    };
    hoisted.readAcpSessionEntryMock.mockImplementation(() => ({
      sessionKey,
      storeSessionKey: sessionKey,
      entry,
      acp: meta,
    }));
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({ id: "acpx", runtime: state.runtime });
    const entered = createDeferred();
    const release = createDeferred();
    state.ensureSession.mockImplementation(async () => {
      entered.resolve();
      await release.promise;
      return { sessionKey, backend: "acpx", runtimeSessionName: meta.runtimeSessionName };
    });
    const manager = new AcpSessionManager();
    const status = manager.getSessionStatus({ cfg: baseCfg, sessionKey });
    let closing: Promise<unknown> | undefined;
    try {
      await entered.promise;
      const expectedControlBinding = {
        sessionId: entry.sessionId,
        lifecycleRevision: entry.lifecycleRevision,
        ownerKey: entry.spawnedBy,
      };
      closing = manager.closeSession({
        cfg: baseCfg,
        sessionKey,
        reason: "terminal-task-cleanup",
        expectedControlBinding,
        discardPersistentState: true,
        allowBackendUnavailable: true,
        clearMeta: true,
      });
      const rejected = expect(closing).rejects.toMatchObject({
        detailCode: "SESSION_ACTOR_SUPERSEDED",
      });
      entry = { ...entry, spawnedBy: "agent:main:replacement-owner" };
      expectedControlBinding.ownerKey = entry.spawnedBy;
      release.resolve();
      await status;
      await rejected;
      expect(state.close).not.toHaveBeenCalled();
      expect(state.prepareFreshSession).not.toHaveBeenCalled();
      expect(hoisted.upsertAcpSessionMetaMock).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await Promise.allSettled([status, closing]);
      await disposeAcpSessionManagerInstance(manager, "fixture-cleanup");
    }
  });
});
