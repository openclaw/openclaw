import { describe, expect, it, vi } from "vitest";
import * as sessionAccessor from "../../config/sessions/session-accessor.js";
import type { SessionAcpMeta } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import {
  type OpenClawTestState,
  withOpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { buildAcpDatabaseSessionKey } from "./session-meta-keys.js";
import {
  readAcpSessionEntry,
  readAcpSessionMetaBatch,
  upsertAcpSessionMeta,
  writeAcpSessionMetaForMigration,
} from "./session-meta.js";

const SESSION_KEY = "agent:main:acp:alias-runtime";
const CANONICAL_META: SessionAcpMeta = {
  backend: "fixture-backend",
  agent: "fixture-harness",
  runtimeSessionName: "canonical-runtime",
  mode: "persistent",
  state: "idle",
  lastActivityAt: 100,
};

async function seedCanonicalSession(state: OpenClawTestState, sessionKey = SESSION_KEY) {
  const cfg: OpenClawConfig = {
    agents: { ownership: "explicit", entries: { main: {} } },
  };
  await state.writeConfig(cfg);
  const scope = { cfg, env: state.env, agentId: "main", sessionKey };
  await sessionAccessor.replaceSessionEntry(scope, {
    sessionId: "alias-session",
    lifecycleRevision: "alias-revision",
    sessionStartedAt: 50,
    updatedAt: 100,
  });
  const entry = sessionAccessor.loadExactSessionEntry(scope)?.entry;
  if (!entry) {
    throw new Error("Expected the canonical session fixture");
  }
  const canonicalKey = buildAcpDatabaseSessionKey(sessionKey, "main");
  writeAcpSessionMetaForMigration({
    env: state.env,
    sessionKey: canonicalKey,
    lifecycleRevision: entry.lifecycleRevision,
    meta: CANONICAL_META,
    now: () => 100,
  });
  const snapshot = () => {
    const { db } = openOpenClawStateDatabase({ env: state.env });
    return {
      rows: db.prepare("SELECT * FROM acp_sessions ORDER BY session_key").all(),
      sources: db.prepare("SELECT * FROM migration_sources ORDER BY source_key").all(),
      runs: db.prepare("SELECT * FROM migration_runs ORDER BY id").all(),
    };
  };
  return { scope, entry, canonicalKey, snapshot };
}

async function seedAliases(state: OpenClawTestState) {
  const fixture = await seedCanonicalSession(state);
  const aliases = [
    { key: SESSION_KEY.toUpperCase(), binding: "alias-revision", updatedAt: 100 },
    { key: "agent:MAIN:acp:alias-runtime", binding: "alias-session", updatedAt: 100 },
    { key: "Agent:main:acp:alias-runtime", binding: undefined, updatedAt: 100 },
  ];
  const retained = [
    { key: "agent:main:ACP:alias-runtime", binding: "old-revision", updatedAt: 100 },
    { key: "agent:main:acp:ALIAS-runtime", binding: "alias-session", updatedAt: 49 },
    { key: "agent:other:acp:alias-runtime", binding: "alias-revision", updatedAt: 100 },
  ];
  for (const row of [...aliases, ...retained]) {
    writeAcpSessionMetaForMigration({
      env: state.env,
      sessionKey: row.key,
      lifecycleRevision: row.binding,
      meta: { ...CANONICAL_META, runtimeSessionName: row.key, lastActivityAt: 200 },
      now: () => row.updatedAt,
    });
  }
  return fixture;
}

describe("ACP raw alias lifecycle", () => {
  it.each(["update", "close"] as const)(
    "%s changes canonical metadata while preserving every historical alias",
    async (operation) => {
      await withOpenClawTestState({ label: `acp-alias-${operation}` }, async (state) => {
        const fixture = await seedAliases(state);
        const before = fixture.snapshot();
        const retainedRows = before.rows.filter((row) => row.session_key !== fixture.canonicalKey);
        const updated = { ...CANONICAL_META, runtimeSessionName: "updated-runtime" };
        await upsertAcpSessionMeta({
          ...fixture.scope,
          mutate: (current) => {
            expect(current).toEqual(CANONICAL_META);
            return operation === "close" ? null : updated;
          },
        });
        const after = fixture.snapshot();
        expect(after.rows.filter((row) => row.session_key !== fixture.canonicalKey)).toEqual(
          retainedRows,
        );
        expect(after.sources).toEqual(before.sources);
        expect(after.runs).toEqual(before.runs);
        expect(readAcpSessionEntry(fixture.scope)?.acp).toEqual(
          operation === "close" ? undefined : updated,
        );
        if (operation === "update") {
          await upsertAcpSessionMeta({ ...fixture.scope, mutate: () => null });
        }
        expect(fixture.snapshot().rows).toEqual(retainedRows);
        await closeOpenClawAgentDatabasesAsync();
        await closeOpenClawStateDatabaseAsync();
        expect(readAcpSessionEntry(fixture.scope)?.acp).toBeUndefined();
        expect(
          readAcpSessionMetaBatch({
            cfg: fixture.scope.cfg,
            env: state.env,
            entries: [{ sessionKey: SESSION_KEY, agentId: "main", entry: fixture.entry }],
          }).get(fixture.entry),
        ).toBeUndefined();
      });
    },
  );

  it.each(["keep", "revoked-update", "revoked-close"] as const)(
    "%s preserves rows, receipts, entry, and events without replaying the callback",
    async (operation) => {
      await withOpenClawTestState({ label: `acp-alias-${operation}` }, async (state) => {
        const fixture = await seedAliases(state);
        const before = fixture.snapshot();
        const entryBefore = sessionAccessor.loadExactSessionEntry(fixture.scope);
        const changes: unknown[] = [];
        const unsubscribe = sessionChanges.subscribe((change) => changes.push(change));
        let current = true;
        const mutate = vi.fn((value: SessionAcpMeta | undefined) => {
          expect(value).toEqual(CANONICAL_META);
          current = operation === "keep";
          return operation === "keep"
            ? undefined
            : operation === "revoked-close"
              ? null
              : { ...CANONICAL_META, runtimeSessionName: "unauthorized-runtime" };
        });
        try {
          const pending = upsertAcpSessionMeta({
            ...fixture.scope,
            mutate,
            assertCommitAllowed: () => {
              if (!current) {
                throw new Error("ACP mutation owner revoked");
              }
            },
          });
          if (operation === "keep") {
            expect((await pending)?.acp).toEqual(CANONICAL_META);
          } else {
            await expect(pending).rejects.toThrow("ACP mutation owner revoked");
          }
          expect(mutate).toHaveBeenCalledOnce();
          expect(fixture.snapshot()).toEqual(before);
          expect(sessionAccessor.loadExactSessionEntry(fixture.scope)).toEqual(entryBefore);
          expect(readAcpSessionEntry(fixture.scope)?.acp).toEqual(CANONICAL_META);
          expect(changes).toEqual([]);
        } finally {
          unsubscribe();
        }
      });
    },
  );

  it.each(["agent:main:acp:binding:configured", "agent:main:main", "encoded database key"])(
    "does not consume case variants outside free ACP runtime keys: %s",
    async (kind) => {
      await withOpenClawTestState({ label: "acp-alias-excluded" }, async (state) => {
        const fixture = await seedCanonicalSession(
          state,
          kind === "encoded database key" ? SESSION_KEY : kind,
        );
        const aliasKey = (
          kind === "encoded database key" ? fixture.canonicalKey : kind
        ).toUpperCase();
        writeAcpSessionMetaForMigration({
          env: state.env,
          sessionKey: aliasKey,
          lifecycleRevision: fixture.entry.lifecycleRevision,
          meta: { ...CANONICAL_META, runtimeSessionName: "excluded-alias" },
          now: () => 100,
        });
        const retainedRows = fixture.snapshot().rows.filter((row) => row.session_key === aliasKey);
        await upsertAcpSessionMeta({ ...fixture.scope, mutate: () => null });
        expect(fixture.snapshot().rows).toEqual(retainedRows);
        expect(readAcpSessionEntry(fixture.scope)?.acp).toBeUndefined();
      });
    },
  );
});
