import { describe, expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { ManagerRuntimeHandleCache } from "./manager.runtime-handle-cache.js";
import {
  createSupersededActorError,
  ensureManagerRuntimeHandle,
} from "./manager.runtime-handle-ensure.js";
import { baseCfg, createRuntime, type SessionAcpMeta } from "./manager.test-helpers.js";
import type { WriteManagerSessionMeta } from "./manager.types.js";

describe("reset during ensured runtime metadata publication", () => {
  it("closes the unpublished stale handle and retains the concurrently accepted successor", async () => {
    const state = createRuntime();
    const target = { sessionKey: "agent:codex:acp:ensure-publication", agentId: "codex" };
    const cache = new ManagerRuntimeHandleCache();
    const writeEntered = createDeferred();
    const releaseWrite = createDeferred();
    let current = true;
    let ensures = 0;
    let writes = 0;
    let persisted: SessionAcpMeta = {
      backend: "acpx",
      agent: "codex",
      runtimeSessionName: "stored-runtime",
      mode: "persistent",
      state: "idle",
      lastActivityAt: 1,
    };
    state.ensureSession.mockImplementation(async () => {
      const id = ++ensures;
      return {
        ...target,
        backend: "acpx",
        runtimeSessionName: `runtime-${id}`,
        backendSessionId: `backend-${id}`,
      };
    });
    const writeSessionMeta: WriteManagerSessionMeta = async (input) => {
      if (++writes === 1) {
        writeEntered.resolve();
        await releaseWrite.promise;
      }
      if (input.isCurrentActor && !input.isCurrentActor()) {
        throw createSupersededActorError(target.sessionKey);
      }
      const entry = { sessionId: "core-session", updatedAt: 1, acp: persisted };
      persisted = input.mutate(persisted, entry) ?? persisted;
      return { ...entry, acp: persisted };
    };
    const params = {
      ...target,
      cfg: baseCfg,
      meta: persisted,
      deps: { requireRuntimeBackend: () => ({ id: "acpx", runtime: state.runtime }) },
      runtimeHandles: cache,
      writeSessionMeta,
    };
    const stale = ensureManagerRuntimeHandle({ ...params, isCurrentActor: () => current });
    const rejected = expect(stale).rejects.toMatchObject({
      detailCode: "SESSION_ACTOR_SUPERSEDED",
    });
    try {
      await writeEntered.promise;
      expect(cache.get(target)).toBeNull();
      current = false;
      const fresh = await ensureManagerRuntimeHandle(params);
      releaseWrite.resolve();
      await rejected;
      expect(state.close).toHaveBeenCalledTimes(1);
      expect(state.close).toHaveBeenCalledWith({
        handle: expect.objectContaining({
          runtimeSessionName: "runtime-1",
          backendSessionId: "backend-1",
        }),
        reason: "session-actor-superseded",
        discardPersistentState: true,
      });
      expect(cache.get(target)?.handle).toBe(fresh.handle);
      expect(persisted.runtimeSessionName).toBe("runtime-2");
    } finally {
      releaseWrite.resolve();
    }
  });
});
