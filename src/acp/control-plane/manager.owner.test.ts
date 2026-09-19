import path from "node:path";
import type { AcpRuntime } from "@openclaw/acp-core/runtime/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadSessionEntryReadOnly,
  replaceSessionEntrySync,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { AcpRuntimeError } from "../runtime/errors.js";
import { buildAcpDatabaseSessionKey } from "../runtime/session-meta-keys.js";
import { readAcpSessionMetaForEntry } from "../runtime/session-meta-readonly.js";
import {
  readAcpSessionEntry,
  writeAcpSessionMetaForMigration,
  upsertAcpSessionMeta,
} from "../runtime/session-meta.js";
import { AcpSessionManager } from "./manager.core.js";
import { disposeAcpSessionManagerInstance } from "./manager.lifecycle.js";
import { DEFAULT_DEPS } from "./manager.types.js";

describe("ACP manager with real owner-scoped metadata", () => {
  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
  });

  it.each(["global", "shared-project"])(
    "isolates two owners of %s and retains the harness",
    async (sessionKey) => {
      await withTestDir({ prefix: "acp-manager-owner-" }, async (dir) => {
        const cfg = {
          agents: { ownership: "explicit", entries: { main: {}, work: {} } },
          session: { scope: "global", store: path.join(dir, "{agentId}", "sessions.json") },
        } satisfies OpenClawConfig;
        const databasePath = path.join(dir, "state", "openclaw.sqlite");
        const ensureSession = vi.fn(async (input: { sessionKey: string; agentId?: string }) => ({
          ...input,
          backend: "synthetic",
          runtimeSessionName: `${input.agentId}/${input.sessionKey}`,
        }));
        const runtime = {
          ownerAwareSessions: 1 as const,
          ensureSession,
          async *runTurn() {
            yield { type: "done" as const };
          },
          async prepareFreshSession() {},
          async cancel() {},
          async close() {},
        } satisfies AcpRuntime;
        const manager = new AcpSessionManager({
          ...DEFAULT_DEPS,
          loadSessionEntry: (input) => readAcpSessionEntry({ ...input, databasePath }),
          upsertSessionMeta: (input) => upsertAcpSessionMeta({ ...input, databasePath }),
          requireRuntimeBackend: () => ({ id: "synthetic", runtime }),
        });
        try {
          for (const agentId of ["main", "work"]) {
            const input = {
              cfg,
              sessionKey,
              agentId,
              agent: "fixture-harness",
              mode: "persistent" as const,
            };
            const scope = {
              agentId,
              sessionKey,
              storePath: path.join(dir, agentId, "sessions.json"),
            };
            const entry = {
              sessionId: `${agentId}-existing`,
              lifecycleRevision: `${agentId}-revision`,
              updatedAt: 1,
            };
            replaceSessionEntrySync(scope, entry);
            const meta = {
              backend: "synthetic",
              agent: "fixture-harness",
              runtimeSessionName: `${agentId}/${sessionKey}`,
              mode: "persistent" as const,
              state: "idle" as const,
              lastActivityAt: 1,
            };
            writeAcpSessionMetaForMigration({
              sessionKey: buildAcpDatabaseSessionKey(sessionKey, agentId),
              lifecycleRevision: entry.lifecycleRevision,
              meta,
              databasePath,
            });
            expect(readAcpSessionEntry({ ...input, databasePath })?.acp).toEqual(
              readAcpSessionMetaForEntry({ ...input, entry, databasePath }),
            );
            expect(manager.resolveSession(input)).toMatchObject({
              kind: "ready",
              agentId,
              sessionKey,
              entry,
            });
            await manager.initializeSession(input);
            expect(loadSessionEntryReadOnly(scope)?.sessionId).toBe(entry.sessionId);
          }
          for (const agentId of ["main", "work"]) {
            const target = { cfg, sessionKey, agentId };
            expect(manager.resolveSession(target)).toMatchObject({
              kind: "ready",
              agentId,
              sessionKey,
              meta: {
                agent: "fixture-harness",
                runtimeSessionName: `${agentId}/${sessionKey}`,
              },
            });
            await manager.updateSessionRuntimeOptions({ ...target, patch: { model: agentId } });
            expect(
              readAcpSessionEntry({ ...target, databasePath })?.acp?.runtimeOptions?.model,
            ).toBe(agentId);
          }
          if (sessionKey === "global") {
            expect(manager.resolveSession({ cfg, sessionKey: "agent:work:main" })).toMatchObject({
              kind: "ready",
              agentId: "work",
              sessionKey: "global",
            });
            const mismatch = { cfg, sessionKey: "agent:work:main", agentId: "main" };
            expect(() => manager.resolveSession(mismatch)).toThrowError(
              expect.objectContaining({ code: "AGENT_SELECTION_REQUIRED" }),
            );
          }
          expect(ensureSession).toHaveBeenCalledTimes(2);
        } finally {
          await disposeAcpSessionManagerInstance(manager, "test-complete");
        }
      });
    },
  );
});

it("keeps legacy runtime implementations assignable and rejects unisolated bare targets before effects", async () => {
  await withTestDir({ prefix: "acp-legacy-owner-" }, async (dir) => {
    const cfg = {
      agents: { ownership: "explicit" as const, entries: { main: {}, work: {} } },
      session: { store: path.join(dir, "{agentId}", "sessions.json") },
    };
    const ensureSession = vi.fn(
      async (input: { sessionKey: string; agent: string; mode: "persistent" | "oneshot" }) => ({
        sessionKey: input.sessionKey,
        backend: "legacy",
        runtimeSessionName: input.sessionKey,
      }),
    );
    const legacyRuntime = {
      ensureSession,
      async *runTurn() {
        yield { type: "done" as const };
      },
      async prepareFreshSession(_input: { sessionKey: string }) {},
      async cancel() {},
      async close() {},
    };
    const runtime: AcpRuntime = legacyRuntime;
    const manager = new AcpSessionManager({
      ...DEFAULT_DEPS,
      requireRuntimeBackend: () => ({ id: "legacy", runtime }),
    });
    try {
      await expect(
        manager.initializeSession({
          cfg,
          agentId: "work",
          sessionKey: "global",
          agent: "fixture",
          mode: "persistent",
        }),
      ).rejects.toMatchObject({ detailCode: "SESSION_OWNER_UNSUPPORTED" });
      expect(ensureSession).not.toHaveBeenCalled();
      await manager.initializeSession({
        cfg,
        agentId: "free-harness",
        sessionKey: "agent:free-harness:acp:legacy",
        agent: "fixture",
        mode: "persistent",
      });
      expect(ensureSession).toHaveBeenCalledOnce();
    } finally {
      await disposeAcpSessionManagerInstance(manager, "test-complete");
    }
  });
});

it("retains canonical metadata when an unmigrated backend locator blocks status or reset", async () => {
  await withTestDir({ prefix: "acp-owner-repair-" }, async (dir) => {
    const cfg = {
      agents: { ownership: "explicit" as const, entries: { work: {} } },
      session: { store: path.join(dir, "{agentId}", "sessions.json") },
    };
    const databasePath = path.join(dir, "state", "openclaw.sqlite");
    const target = { cfg, sessionKey: "global", agentId: "work" };
    const runtime = {
      ownerAwareSessions: 1 as const,
      ensureSession: vi.fn(async () => ({
        sessionKey: "global",
        backend: "synthetic",
        runtimeSessionName: "legacy-global",
      })),
      async *runTurn() {
        yield { type: "done" as const };
      },
      prepareFreshSession: vi.fn(async () => {}),
      async cancel() {},
      close: vi.fn(async () => {}),
    } satisfies AcpRuntime;
    const deps = {
      ...DEFAULT_DEPS,
      loadSessionEntry: (input: Parameters<typeof readAcpSessionEntry>[0]) =>
        readAcpSessionEntry({ ...input, databasePath }),
      upsertSessionMeta: (input: Parameters<typeof upsertAcpSessionMeta>[0]) =>
        upsertAcpSessionMeta({ ...input, databasePath }),
      requireRuntimeBackend: () => ({ id: "synthetic", runtime }),
      getRuntimeBackend: () => ({ id: "synthetic", runtime }),
    };
    const initial = new AcpSessionManager(deps);
    try {
      await initial.initializeSession({ ...target, agent: "fixture", mode: "persistent" });
    } finally {
      await disposeAcpSessionManagerInstance(initial, "restart");
    }
    const before = readAcpSessionEntry({ ...target, databasePath })?.acp;
    const repairError = new AcpRuntimeError(
      "ACP_SESSION_INIT_FAILED",
      "Run offline Doctor repair",
      { detailCode: "SESSION_OWNER_MIGRATION_REQUIRED" },
    );
    runtime.ensureSession.mockRejectedValue(repairError);
    runtime.prepareFreshSession.mockRejectedValue(repairError);
    runtime.close.mockClear();
    const manager = new AcpSessionManager(deps);
    try {
      await expect(manager.getSessionStatus(target)).rejects.toBe(repairError);
      // Retained resets (clearMeta false or omitted) must still reject: the residue
      // record is retained and the owner-repair verdict protects it from silent mutation.
      for (const clearMeta of [false, undefined]) {
        for (const discardPersistentState of [false, true]) {
          await expect(
            manager.closeSession({
              ...target,
              reason: "reset",
              clearMeta,
              discardPersistentState,
              allowBackendUnavailable: true,
            }),
          ).rejects.toBe(repairError);
          expect(readAcpSessionEntry({ ...target, databasePath })?.acp).toEqual(before);
        }
      }
      // Non-discarding close must still reject even when clearMeta is true.
      await expect(
        manager.closeSession({
          ...target,
          reason: "reset",
          clearMeta: true,
          discardPersistentState: false,
          allowBackendUnavailable: true,
        }),
      ).rejects.toBe(repairError);
      expect(readAcpSessionEntry({ ...target, databasePath })?.acp).toEqual(before);
      // Discarding close with clearMeta true proceeds: the residue record is being
      // destroyed, so its provenance verdict cannot block teardown (issue #151859).
      await manager.closeSession({
        ...target,
        reason: "reset",
        clearMeta: true,
        discardPersistentState: true,
        allowBackendUnavailable: true,
      });
      expect(readAcpSessionEntry({ ...target, databasePath })?.acp).toBeUndefined();
      expect(runtime.close).not.toHaveBeenCalled();
    } finally {
      await disposeAcpSessionManagerInstance(manager, "test-complete");
    }
  });
});

it("retains canonical metadata when an unmigrated backend locator blocks recovery reset on stable session id", async () => {
  await withTestDir({ prefix: "acp-owner-repair-stable-" }, async (dir) => {
    const cfg = {
      agents: { ownership: "explicit" as const, entries: { work: {} } },
      session: { store: path.join(dir, "{agentId}", "sessions.json") },
    };
    const databasePath = path.join(dir, "state", "openclaw.sqlite");
    const target = { cfg, sessionKey: "global", agentId: "work" };
    const runtime = {
      ownerAwareSessions: 1 as const,
      ensureSession: vi.fn(async () => ({
        sessionKey: "global",
        backend: "synthetic",
        runtimeSessionName: "legacy-global",
        agentSessionId: "agent-session-1",
      })),
      async *runTurn() {
        yield { type: "done" as const };
      },
      prepareFreshSession: vi.fn(async () => {}),
      async cancel() {},
      close: vi.fn(async () => {}),
    } satisfies AcpRuntime;
    const deps = {
      ...DEFAULT_DEPS,
      loadSessionEntry: (input: Parameters<typeof readAcpSessionEntry>[0]) =>
        readAcpSessionEntry({ ...input, databasePath }),
      upsertSessionMeta: (input: Parameters<typeof upsertAcpSessionMeta>[0]) =>
        upsertAcpSessionMeta({ ...input, databasePath }),
      requireRuntimeBackend: () => ({ id: "synthetic", runtime }),
      getRuntimeBackend: () => ({ id: "synthetic", runtime }),
    };
    const initial = new AcpSessionManager(deps);
    try {
      await initial.initializeSession({ ...target, agent: "fixture", mode: "persistent" });
    } finally {
      await disposeAcpSessionManagerInstance(initial, "restart");
    }
    const before = readAcpSessionEntry({ ...target, databasePath })?.acp;
    const repairError = new AcpRuntimeError(
      "ACP_SESSION_INIT_FAILED",
      "Run offline Doctor repair",
      { detailCode: "SESSION_OWNER_MIGRATION_REQUIRED" },
    );
    runtime.ensureSession.mockRejectedValue(repairError);
    runtime.prepareFreshSession.mockRejectedValue(repairError);
    runtime.close.mockClear();
    const manager = new AcpSessionManager(deps);
    try {
      await expect(manager.getSessionStatus(target)).rejects.toBe(repairError);
      for (const clearMeta of [false, undefined]) {
        for (const discardPersistentState of [false, true]) {
          await expect(
            manager.closeSession({
              ...target,
              reason: "reset",
              clearMeta,
              discardPersistentState,
              allowBackendUnavailable: true,
            }),
          ).rejects.toBe(repairError);
          expect(readAcpSessionEntry({ ...target, databasePath })?.acp).toEqual(before);
        }
      }
      await expect(
        manager.closeSession({
          ...target,
          reason: "reset",
          clearMeta: true,
          discardPersistentState: false,
          allowBackendUnavailable: true,
        }),
      ).rejects.toBe(repairError);
      expect(readAcpSessionEntry({ ...target, databasePath })?.acp).toEqual(before);

      const result = await manager.closeSession({
        ...target,
        reason: "reset",
        clearMeta: true,
        discardPersistentState: true,
        allowBackendUnavailable: true,
      });
      expect(result.metaCleared).toBe(true);
      expect(result.runtimeNotice).toBe(repairError.message);
      expect(readAcpSessionEntry({ ...target, databasePath })?.acp).toBeUndefined();
      expect(runtime.close).not.toHaveBeenCalled();
    } finally {
      await disposeAcpSessionManagerInstance(manager, "test-complete");
    }
  });
});
