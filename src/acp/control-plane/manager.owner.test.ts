import path from "node:path";
import type { AcpRuntime } from "@openclaw/acp-core/runtime/types";
import { expect, it, vi } from "vitest";
import {
  loadSessionEntryReadOnly,
  replaceSessionEntrySync,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { AcpRuntimeError } from "../runtime/errors.js";
import { buildAcpDatabaseSessionKey } from "../runtime/session-meta-keys.js";
import { readAcpSessionMetaForEntry } from "../runtime/session-meta-readonly.js";
import {
  readAcpSessionEntry,
  readAcpSessionEntryAsync,
  writeAcpSessionMetaForMigration,
  upsertAcpSessionMeta,
} from "../runtime/session-meta.js";
import { AcpSessionManager } from "./manager.core.js";
import { disposeAcpSessionManagerInstance } from "./manager.lifecycle.js";
import { DEFAULT_DEPS } from "./manager.types.js";

async function runWithManager(
  deps: ConstructorParameters<typeof AcpSessionManager>[0],
  run: (manager: AcpSessionManager) => Promise<unknown>,
  reason = "test-complete",
) {
  const manager = new AcpSessionManager(deps);
  try {
    await run(manager);
  } finally {
    await disposeAcpSessionManagerInstance(manager, reason);
  }
}

async function withManagerTestDir(prefix: string, run: (dir: string) => Promise<void>) {
  await withTestDir({ prefix }, async (dir) => {
    try {
      await run(dir);
    } finally {
      // Worker leases must settle before the fixture removes their database files.
      await closeOpenClawAgentDatabasesAsync();
      await closeOpenClawStateDatabaseAsync();
    }
  });
}

function ownerFixture(
  dir: string,
  scope?: "global",
  entries: Record<string, object> = { main: {}, work: {} },
) {
  const cfg = {
    agents: { ownership: "explicit", entries },
    session: { scope, store: path.join(dir, "{agentId}", "sessions.json") },
  } satisfies OpenClawConfig;
  const databasePath = path.join(dir, "state", "openclaw.sqlite");
  const runtime = {
    ownerAwareSessions: 1 as const,
    ensureSession: vi.fn(async (input: { sessionKey: string; agentId?: string }) => ({
      ...input,
      backend: "synthetic",
      runtimeSessionName: `${input.agentId}/${input.sessionKey}`,
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
    loadSessionEntryAsync: (input: Parameters<typeof readAcpSessionEntryAsync>[0]) =>
      readAcpSessionEntryAsync({ ...input, databasePath }),
    upsertSessionMeta: (input: Parameters<typeof upsertAcpSessionMeta>[0]) =>
      upsertAcpSessionMeta({ ...input, databasePath }),
    requireRuntimeBackend: () => ({ id: "synthetic", runtime }),
  };
  const target = (agentId: string, sessionKey = "global") => ({ cfg, agentId, sessionKey });
  const initialize = (agentId: string, sessionKey = "global", agent = "fixture") => ({
    ...target(agentId, sessionKey),
    agent,
    mode: "persistent" as const,
  });
  const readMeta = (input: ReturnType<typeof target>) =>
    readAcpSessionEntry({ ...input, databasePath })?.acp;
  return { cfg, databasePath, runtime, deps, target, initialize, readMeta };
}

it("isolates two owners of global and retains the harness", async () => {
  const sessionKey = "global";
  const ready = (agentId: string) => ({ kind: "ready", agentId, sessionKey });
  await withManagerTestDir("acp-manager-owner-", async (dir) => {
    const { cfg, databasePath, runtime, deps, target, initialize, readMeta } = ownerFixture(
      dir,
      "global",
    );
    await runWithManager(deps, async (manager) => {
      for (const agentId of ["main", "work"]) {
        const input = initialize(agentId, sessionKey, "fixture-harness");
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
        expect(manager.resolveSession(input)).toMatchObject({ ...ready(agentId), entry });
        await manager.initializeSession(input);
        expect(loadSessionEntryReadOnly(scope)?.sessionId).toBe(entry.sessionId);
      }
      for (const agentId of ["main", "work"]) {
        const owner = target(agentId);
        expect(manager.resolveSession(owner)).toMatchObject({
          ...ready(agentId),
          meta: {
            agent: "fixture-harness",
            runtimeSessionName: `${agentId}/${sessionKey}`,
          },
        });
        await manager.updateSessionRuntimeOptions({ ...owner, patch: { model: agentId } });
        expect(readMeta(owner)?.runtimeOptions?.model).toBe(agentId);
      }
      expect(manager.resolveSession({ cfg, sessionKey: "agent:work:main" })).toMatchObject(
        ready("work"),
      );
      const mismatch = { cfg, sessionKey: "agent:work:main", agentId: "main" };
      expect(() => manager.resolveSession(mismatch)).toThrowError(
        expect.objectContaining({ code: "AGENT_SELECTION_REQUIRED" }),
      );
      expect(runtime.ensureSession).toHaveBeenCalledTimes(2);
    });
  });
});

it("keeps legacy runtime implementations assignable and rejects unisolated bare targets before effects", async () => {
  await withManagerTestDir("acp-legacy-owner-", async (dir) => {
    const { initialize } = ownerFixture(dir);
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
    const deps = {
      ...DEFAULT_DEPS,
      requireRuntimeBackend: () => ({ id: "legacy", runtime }),
    };
    await runWithManager(deps, async (manager) => {
      await expect(manager.initializeSession(initialize("work"))).rejects.toMatchObject({
        detailCode: "SESSION_OWNER_UNSUPPORTED",
      });
      expect(ensureSession).not.toHaveBeenCalled();
      await manager.initializeSession(initialize("free-harness", "agent:free-harness:acp:legacy"));
      expect(ensureSession).toHaveBeenCalledOnce();
    });
  });
});

it("retains canonical metadata when an unmigrated backend locator blocks status or reset", async () => {
  await withManagerTestDir("acp-owner-repair-", async (dir) => {
    const { cfg, runtime, deps, initialize, readMeta } = ownerFixture(dir, undefined, { work: {} });
    const target = { cfg, sessionKey: "global", agentId: "work" };
    runtime.ensureSession.mockResolvedValue({
      sessionKey: "global",
      backend: "synthetic",
      runtimeSessionName: "legacy-global",
    });
    const repairDeps = { ...deps, getRuntimeBackend: deps.requireRuntimeBackend };
    await runWithManager(
      repairDeps,
      (initial) => initial.initializeSession(initialize("work")),
      "restart",
    );
    const before = readMeta(target);
    const repairError = new AcpRuntimeError(
      "ACP_SESSION_INIT_FAILED",
      "Run offline Doctor repair",
      { detailCode: "SESSION_OWNER_MIGRATION_REQUIRED" },
    );
    runtime.ensureSession.mockRejectedValue(repairError);
    runtime.prepareFreshSession.mockRejectedValue(repairError);
    runtime.close.mockClear();
    await runWithManager(repairDeps, async (manager) => {
      await expect(manager.getSessionStatus(target)).rejects.toBe(repairError);
      for (const discardPersistentState of [false, true]) {
        await expect(
          manager.closeSession({
            ...target,
            reason: "reset",
            clearMeta: true,
            discardPersistentState,
            allowBackendUnavailable: true,
          }),
        ).rejects.toBe(repairError);
        expect(readMeta(target)).toEqual(before);
      }
      expect(runtime.close).not.toHaveBeenCalled();
    });
  });
});
