import { describe, expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  AcpSessionManager,
  baseCfg,
  createRuntime,
  hoisted,
  installAcpSessionManagerTestLifecycle,
  readySessionMeta,
} from "./manager.test-helpers.js";
import type { WriteManagerSessionMeta } from "./manager.types.js";

describe("ACP metadata-only command authority", () => {
  installAcpSessionManagerTestLifecycle();

  it.each(["update", "reset"] as const)(
    "rechecks the admitted requester before an awaited %s commits",
    async (operation) => {
      const sessionKey = "agent:codex:acp:requester-authority";
      const runtime = createRuntime();
      const entered = createDeferred();
      const release = createDeferred();
      let current = true;
      let meta = readySessionMeta({ runtimeOptions: { cwd: "/workspace/original" } });
      const entry = () => ({ sessionId: "requester-authority", updatedAt: 1, acp: meta });
      hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
        id: "acpx",
        runtime: runtime.runtime,
      });
      hoisted.readAcpSessionEntryMock.mockImplementation(() => ({
        sessionKey,
        storeSessionKey: sessionKey,
        entry: entry(),
        acp: meta,
      }));
      hoisted.upsertAcpSessionMetaMock.mockImplementation(
        async (input: Parameters<WriteManagerSessionMeta>[0]) => {
          const next = input.mutate(meta, entry());
          entered.resolve();
          await release.promise;
          input.assertCommitAllowed?.();
          meta = next ?? meta;
          return entry();
        },
      );
      const manager = new AcpSessionManager();
      const target = {
        cfg: baseCfg,
        sessionKey,
        assertActive: () => {
          if (!current) {
            throw new Error("requester authority revoked");
          }
        },
      };
      const pending =
        operation === "update"
          ? manager.updateSessionRuntimeOptions({ ...target, patch: { cwd: "/workspace/changed" } })
          : manager.resetSessionRuntimeOptions(target);
      const rejected = expect(pending).rejects.toThrow("requester authority revoked");
      await entered.promise;
      current = false;
      release.resolve();
      await rejected;
      expect(meta.runtimeOptions).toEqual({ cwd: "/workspace/original" });
      expect(runtime.ensureSession).not.toHaveBeenCalled();
      expect(runtime.close).not.toHaveBeenCalled();
    },
  );
});
