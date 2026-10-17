import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { captureRuntimeConfigAsyncReader } from "../../config/io.runtime.js";
import { resetConfigRuntimeState } from "../../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { SessionAcpMeta } from "../../config/sessions/types.js";
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
import * as stateReadPool from "../../state/openclaw-state-read-pool.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { seedCanonicalAcpSessionMeta } from "./session-meta-fixture.test-support.js";
import { buildAcpDatabaseSessionKey } from "./session-meta-keys.js";
import { readAcpSessionEntryAsync, readAcpSessionMetaAsync } from "./session-meta-read.js";
import * as metadataReads from "./session-meta-readonly.js";
import { upsertAcpSessionMeta } from "./session-meta-write.js";

const meta: SessionAcpMeta = {
  backend: "acpx",
  agent: "main",
  runtimeSessionName: "original-runtime",
  mode: "persistent",
  state: "idle",
  lastActivityAt: 100,
};

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
      const cfg = {
        agents: { ownership: "explicit" as const, entries: { main: {} } },
        ...(storePath ? { session: { store: storePath } } : {}),
      };
      await state.writeConfig(cfg);
      const sessionKey = incognito ? "agent:main:dashboard:incognito-private" : "agent:main:main";
      const entry = {
        sessionId: "session",
        lifecycleRevision: "original",
        updatedAt: 100,
        skillsSnapshot: { prompt: "Saved instructions", skills: [{ name: "fixture" }] },
      };
      await replaceSessionEntry({ agentId: "main", storePath, sessionKey, env: state.env }, entry);
      const databaseKey = buildAcpDatabaseSessionKey(sessionKey, "main");
      seedCanonicalAcpSessionMeta({
        env: state.env,
        sessionKey: databaseKey,
        lifecycleRevision: "original",
        meta,
      });
      if (!incognito) {
        await closeOpenClawAgentDatabasesAsync();
        await closeOpenClawStateDatabaseAsync();
        resetConfigRuntimeState();
      }
      const sql = observeMainThreadSql();
      try {
        const result = await readAcpSessionEntryAsync(
          incognito
            ? { cfg, env: state.env, sessionKey }
            : { sessionKey: " main ", agentId: "main" },
        );
        expect(result).toMatchObject({
          sessionKey: incognito ? sessionKey : "main",
          storeSessionKey: sessionKey,
          agentId: "main",
          ...(storePath ? { storePath } : {}),
          entry: {
            sessionId: entry.sessionId,
            lifecycleRevision: entry.lifecycleRevision,
            skillsSnapshot: entry.skillsSnapshot,
          },
          acp: meta,
        });
        if (incognito) {
          expect(
            fs.existsSync(
              resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env: state.env }),
            ),
          ).toBe(false);
          expect(
            fs.existsSync(resolveOpenClawAgentSqlitePath({ agentId: "main", env: state.env })),
          ).toBe(false);
        } else {
          expect(await readAcpSessionMetaAsync({ sessionKey, agentId: "main" })).toEqual(meta);
          expect(
            await metadataReads.readAcpSessionMetaForEntryAsync({ sessionKey, entry }),
          ).toEqual(meta);
          await upsertAcpSessionMeta({
            cfg,
            env: state.env,
            sessionKey,
            mutate: () => ({ ...meta, runtimeSessionName: "updated-runtime" }),
          });
          expect(
            await metadataReads.readAcpSessionMetaForEntryAsync({ sessionKey, entry }),
          ).toMatchObject({ runtimeSessionName: "updated-runtime" });
          expect(
            await metadataReads.readAcpSessionMetaForEntryAsync({
              sessionKey,
              entry: { ...entry, lifecycleRevision: "retired" },
            }),
          ).toBeUndefined();
        }
        sql.expectIdle();
      } finally {
        sql.restore();
      }
    });
  },
);

it("retains absent ACP metadata across async reads and follows in-process set and clear", async () => {
  await withOpenClawTestState({ label: "acp-absent-receipt" }, async (state) => {
    const sessionKey = "agent:main:acp:absent";
    const cfg = { agents: { ownership: "explicit" as const, entries: { main: {} } } };
    const entry = { sessionId: "session", lifecycleRevision: "original", updatedAt: 100 };
    await state.writeConfig(cfg);
    await captureRuntimeConfigAsyncReader()();
    await replaceSessionEntry({ agentId: "main", sessionKey, env: state.env }, entry);
    openOpenClawStateDatabase({ env: state.env });
    const read = () =>
      metadataReads.readAcpSessionMetaForEntryAsync({
        sessionKey,
        agentId: "main",
        entry,
        env: state.env,
      });
    const requests = vi.spyOn(stateReadPool, "startReadTask");
    const sql = observeMainThreadSql();
    try {
      expect(await read()).toBeUndefined();
      expect(requests).toHaveBeenCalledTimes(1);
      requests.mockClear();
      expect(await read()).toBeUndefined();
      expect(requests).not.toHaveBeenCalled();

      await upsertAcpSessionMeta({ cfg, env: state.env, sessionKey, mutate: () => meta });
      requests.mockClear();
      expect(await read()).toEqual(meta);
      expect(requests).not.toHaveBeenCalled();

      await upsertAcpSessionMeta({ cfg, env: state.env, sessionKey, mutate: () => null });
      requests.mockClear();
      expect(await read()).toBeUndefined();
      expect(requests).not.toHaveBeenCalled();
      sql.expectIdle();
    } finally {
      sql.restore();
      requests.mockRestore();
    }
  });
});

it("preserves missing-entry binding fences and unreadable-store results without creating stores", async () => {
  await withOpenClawTestState({ label: "acp-singular-missing" }, async (state) => {
    const storePath = state.path("absent", "custom.sqlite");
    const sessionKey = "agent:main:acp:missing";
    const input = { cfg: { session: { store: storePath } }, env: state.env, sessionKey };
    seedCanonicalAcpSessionMeta({ env: state.env, sessionKey, meta });
    expect(await readAcpSessionEntryAsync(input)).toMatchObject({
      sessionKey,
      entry: undefined,
      acp: meta,
    });
    expect(fs.existsSync(path.dirname(storePath))).toBe(false);

    // A bound primary row wins selection, then fails its missing-entry fence.
    // Missing entries must not make a bound canonical row readable.
    seedCanonicalAcpSessionMeta({
      env: state.env,
      sessionKey: buildAcpDatabaseSessionKey(sessionKey, "main"),
      lifecycleRevision: "old-lifecycle",
      meta,
    });
    expect((await readAcpSessionEntryAsync(input))?.acp).toBeUndefined();

    fs.mkdirSync(path.dirname(storePath));
    fs.writeFileSync(storePath, "Not a SQLite store");
    expect(await readAcpSessionEntryAsync(input)).toMatchObject({
      storeReadFailed: true,
      entry: undefined,
      acp: undefined,
    });
    expect(fs.readFileSync(storePath, "utf8")).toBe("Not a SQLite store");

    const legacyKey = "agent:main:acp:unbound";
    seedCanonicalAcpSessionMeta({ env: state.env, sessionKey: legacyKey, meta });
    expect(await readAcpSessionEntryAsync({ ...input, sessionKey: legacyKey })).toMatchObject({
      storeReadFailed: true,
      entry: undefined,
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
        { sessionId: "held", lifecycleRevision: "original", updatedAt: 100 },
      );
      seedCanonicalAcpSessionMeta({
        env: state.env,
        sessionKey: buildAcpDatabaseSessionKey(sessionKey, "main"),
        lifecycleRevision: "original",
        meta,
      });
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
