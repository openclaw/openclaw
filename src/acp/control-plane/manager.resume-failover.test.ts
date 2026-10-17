import { describe, expect, it } from "vitest";
import {
  AcpRuntimeError,
  AcpSessionManager,
  baseCfg,
  createRuntime,
  hoisted,
  installAcpSessionManagerTestLifecycle,
  readySessionMeta,
} from "./manager.test-helpers.js";
import type { WriteManagerSessionMeta } from "./manager.types.js";

describe("one-shot resume backend ownership", () => {
  installAcpSessionManagerTestLifecycle();

  it.each(["resume", "terminal-write"] as const)(
    "does not fail over on %s failure",
    async (phase) => {
      const primary = createRuntime();
      const fallback = createRuntime();
      const sessionKey = "agent:codex:acp:resume-failover";
      const identity = {
        state: "resolved" as const,
        source: "status" as const,
        acpxSessionId: "primary-session",
        sessionResumeSupported: true,
        sessionResumeReady: true,
        lastUpdatedAt: 1,
      };
      let meta = readySessionMeta({
        backend: "primary",
        mode: "oneshot",
        runtimeSessionName: "primary-runtime",
        ...(phase === "resume" ? { identity } : {}),
      });
      hoisted.readAcpSessionEntryMock.mockImplementation(() => ({
        sessionKey,
        storeSessionKey: sessionKey,
        entry: { sessionId: "child", updatedAt: 1 },
        acp: meta,
      }));
      hoisted.requireAcpRuntimeBackendMock.mockImplementation((backend: string) => ({
        id: backend,
        runtime: backend === "primary" ? primary.runtime : fallback.runtime,
      }));
      primary.ensureSession.mockResolvedValue({
        sessionKey,
        backend: "primary",
        runtimeSessionName: "primary-runtime",
        backendSessionId: "primary-session",
        sessionResumeSupported: true,
      });
      if (phase === "resume") {
        primary.ensureSession.mockRejectedValue(
          new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "primary unavailable"),
        );
      }
      hoisted.upsertAcpSessionMetaMock.mockImplementation(
        async (input: Parameters<WriteManagerSessionMeta>[0]) => {
          const next = input.mutate(meta, { sessionId: "child", updatedAt: 1 });
          if (phase === "terminal-write" && next?.identity?.sessionResumeReady) {
            throw new Error("resume metadata temporarily unavailable");
          }
          meta = next ?? meta;
          return { sessionId: "child", updatedAt: 1, acp: meta };
        },
      );

      await expect(
        new AcpSessionManager().runTurn({
          cfg: {
            ...baseCfg,
            acp: {
              ...baseCfg.acp,
              backend: phase === "resume" ? "fallback" : "primary",
              fallbacks: ["fallback"],
            },
          },
          sessionKey,
          mode: "prompt",
          text: "Continue",
          requestId: phase,
          provenance: "system",
        }),
      ).rejects.toMatchObject({
        message:
          phase === "resume" ? "primary unavailable" : "resume metadata temporarily unavailable",
      });
      expect(fallback.ensureSession).not.toHaveBeenCalled();
      expect(fallback.runTurn).not.toHaveBeenCalled();
      expect(primary.runTurn).toHaveBeenCalledTimes(phase === "resume" ? 0 : 1);
      if (phase === "resume") {
        expect(primary.ensureSession).toHaveBeenCalledWith(
          expect.objectContaining({ resumeSessionId: "primary-session" }),
        );
        expect(meta.identity).toEqual(identity);
      } else {
        expect(primary.close).toHaveBeenCalledOnce();
      }
    },
  );
});
