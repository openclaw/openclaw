import fs from "node:fs";
import path from "node:path";
import { WorkerTaskPoolCore } from "@openclaw/worker-runtime";
import { afterEach, expect, it, vi } from "vitest";
import { captureRuntimeConfigAsyncReader } from "../../config/io.runtime.js";
import { resetConfigRuntimeState } from "../../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { registerOpenClawAgentDatabaseAsyncResource } from "../../state/openclaw-agent-db-resources.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  closeOpenClawAgentDatabasesAsync,
  resolveIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { seedCanonicalAcpSessionMeta } from "./session-meta-fixture.test-support.js";
import { buildAcpDatabaseSessionKey } from "./session-meta-keys.js";
import { createAcpMeta } from "./session-meta-lifecycle.test-support.js";
import { listAcpSessionEntries } from "./session-meta-list.js";
import { readAcpSessionEntryAsync, readAcpSessionMetaAsync } from "./session-meta-read.js";
import * as metadataReads from "./session-meta-readonly.js";
import { upsertAcpSessionMeta } from "./session-meta-write.js";

const meta = createAcpMeta({ backend: "acpx" });
const baseEntry = { sessionId: "session", lifecycleRevision: "original", updatedAt: 100 };
const baseConfig = { agents: { ownership: "explicit" as const, entries: { main: {} } } };
function seed(env: NodeJS.ProcessEnv, sessionKey: string, lifecycleRevision?: string) {
  seedCanonicalAcpSessionMeta({ env, sessionKey, lifecycleRevision, meta });
}

afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
});

it.each(["cold-file", "incognito"] as const)(
  "joins the %s session with its current metadata through the owning storage route",
  async (storage) => {
    await withOpenClawTestState({ label: `acp-singular-${storage}` }, async (state) => {
      const incognito = storage === "incognito";
      const storePath = incognito ? undefined : state.path("custom.sqlite");
      const sessionKey = incognito ? "agent:main:dashboard:incognito-private" : "agent:main:main";
      const entry = {
        ...baseEntry,
        skillsSnapshot: { prompt: "Saved instructions", skills: [{ name: "fixture" }] },
      };
      const cfg = { ...baseConfig, ...(storePath ? { session: { store: storePath } } : {}) };
      await state.writeConfig(cfg);
      await replaceSessionEntry({ agentId: "main", storePath, sessionKey, env: state.env }, entry);
      seed(state.env, buildAcpDatabaseSessionKey(sessionKey, "main"), "original");
      if (!incognito) {
        await closeOpenClawAgentDatabasesAsync();
        await closeOpenClawStateDatabaseAsync();
        resetConfigRuntimeState();
      }
      const sql = observeMainThreadSql();
      const result = await readAcpSessionEntryAsync(
        incognito ? { cfg, env: state.env, sessionKey } : { sessionKey: " main ", agentId: "main" },
      );
      expect(result).toMatchObject({
        sessionKey: incognito ? sessionKey : "main",
        storeSessionKey: sessionKey,
        agentId: "main",
        ...(storePath ? { storePath } : {}),
        entry,
        acp: meta,
      });
      if (incognito) {
        expect(
          [resolveIncognitoOpenClawAgentSqlitePath, resolveOpenClawAgentSqlitePath].map((resolve) =>
            fs.existsSync(resolve({ agentId: "main", env: state.env })),
          ),
        ).toEqual([false, false]);
      } else {
        const readMeta = (current = entry) =>
          metadataReads.readAcpSessionMetaForEntryAsync({ sessionKey, entry: current });
        expect(await readAcpSessionMetaAsync({ sessionKey, agentId: "main" })).toEqual(meta);
        expect(await readMeta()).toEqual(meta);
        await upsertAcpSessionMeta({
          cfg,
          env: state.env,
          sessionKey,
          mutate: () => ({ ...meta, runtimeSessionName: "updated-runtime" }),
        });
        expect(await readMeta()).toMatchObject({ runtimeSessionName: "updated-runtime" });
        expect(await readMeta({ ...entry, lifecycleRevision: "retired" })).toBeUndefined();
        await replaceSessionEntry(
          { agentId: "main", storePath, sessionKey, env: state.env },
          { ...entry, lifecycleRevision: "retired" },
        );
        expect(await listAcpSessionEntries({ cfg, env: state.env })).toEqual([]);
      }
      sql.expectIdle();
    });
  },
);

it("retains absent ACP metadata across async reads and follows in-process set and clear", async () => {
  await withOpenClawTestState({ label: "acp-absent-receipt" }, async (state) => {
    const sessionKey = "agent:main:acp:absent";
    const entry = baseEntry;
    const cfg = baseConfig;
    await state.writeConfig(cfg);
    await captureRuntimeConfigAsyncReader()();
    await replaceSessionEntry({ agentId: "main", sessionKey, env: state.env }, entry);
    openOpenClawStateDatabase({ env: state.env });
    const requests = vi.spyOn(WorkerTaskPoolCore.prototype, "runTask");
    const input = { sessionKey, agentId: "main", entry, env: state.env };
    const expectRead = async (expected: typeof meta | undefined, calls = 0) => {
      expect(await metadataReads.readAcpSessionMetaForEntryAsync(input)).toEqual(expected);
      expect(requests).toHaveBeenCalledTimes(calls);
      requests.mockClear();
    };
    const sql = observeMainThreadSql();
    await expectRead(undefined, 1);
    await expectRead(undefined);
    await upsertAcpSessionMeta({ cfg, env: state.env, sessionKey, mutate: () => meta });
    requests.mockClear();
    await expectRead(meta);
    await upsertAcpSessionMeta({ cfg, env: state.env, sessionKey, mutate: () => null });
    requests.mockClear();
    await expectRead(undefined);
    sql.expectIdle();
  });
});

it("preserves missing-entry binding fences and unreadable-store results without creating stores", async () => {
  await withOpenClawTestState({ label: "acp-singular-missing" }, async (state) => {
    const storePath = state.path("absent", "custom.sqlite");
    const sessionKey = "agent:main:acp:missing";
    const input = { cfg: { session: { store: storePath } }, env: state.env, sessionKey };
    const missing = { entry: undefined };
    const unreadable = { ...missing, storeReadFailed: true };
    seed(state.env, sessionKey);
    expect(await readAcpSessionEntryAsync(input)).toMatchObject({
      ...missing,
      sessionKey,
      acp: meta,
    });
    expect(fs.existsSync(path.dirname(storePath))).toBe(false);

    // A bound canonical row cannot outlive its entry.
    seed(state.env, buildAcpDatabaseSessionKey(sessionKey, "main"), "old-lifecycle");
    expect((await readAcpSessionEntryAsync(input))?.acp).toBeUndefined();

    fs.mkdirSync(path.dirname(storePath));
    fs.writeFileSync(storePath, "Not a SQLite store");
    expect(await readAcpSessionEntryAsync(input)).toMatchObject({ ...unreadable, acp: undefined });
    expect(fs.readFileSync(storePath, "utf8")).toBe("Not a SQLite store");

    const legacyKey = "agent:main:acp:unbound";
    seed(state.env, legacyKey);
    expect(await readAcpSessionEntryAsync({ ...input, sessionKey: legacyKey })).toMatchObject({
      ...unreadable,
      acp: meta,
    });
  });
});

it.each(["caller", "store"] as const)(
  "rejects a retired %s while the metadata join is held",
  async (retired) => {
    await withOpenClawTestState({ label: "acp-singular-retirement" }, async (state) => {
      const storePath = state.path("custom.sqlite");
      const sessionKey = "agent:main:acp:held";
      const cfg = { session: { store: storePath } };
      await replaceSessionEntry(
        { agentId: "main", storePath, sessionKey, env: state.env },
        { ...baseEntry, sessionId: "held" },
      );
      seed(state.env, buildAcpDatabaseSessionKey(sessionKey, "main"), "original");
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const read = metadataReads.readAcpSessionMetaForEntries;
      vi.spyOn(metadataReads, "readAcpSessionMetaForEntries").mockImplementationOnce(
        async (input) => {
          const result = await read(input);
          entered.resolve();
          await release.promise;
          return result;
        },
      );
      let current = true;
      const pending = readAcpSessionEntryAsync({
        cfg,
        env: state.env,
        sessionKey,
        assertCurrent: () => {
          if (!current) {
            throw new Error("ACP caller retired");
          }
        },
      });
      const rejected = expect(pending).rejects.toThrow(
        /retired|closed|revoked|current|source changed/i,
      );
      await entered.promise;
      let closing: Promise<boolean> | undefined;
      let unregister: (() => void) | undefined;
      try {
        if (retired === "caller") {
          current = false;
        } else {
          const revoked = createDeferredCore();
          unregister = registerOpenClawAgentDatabaseAsyncResource({
            agentId: "main",
            path: storePath,
            revoke: () => revoked.resolve(),
            close: async () => {},
          });
          closing = closeOpenClawAgentDatabaseByPathAsync(storePath, "main");
          await revoked.promise;
        }
        release.resolve();
        await rejected;
      } finally {
        release.resolve();
        await Promise.allSettled([pending, ...(closing ? [closing] : [])]);
        unregister?.();
      }
    });
  },
);
