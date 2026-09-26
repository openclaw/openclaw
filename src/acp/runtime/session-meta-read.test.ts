import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
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
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { buildAcpDatabaseSessionKey } from "./session-meta-keys.js";
import { readAcpSessionEntryAsync, readAcpSessionMetaAsync } from "./session-meta-read.js";
import * as metadataReads from "./session-meta-readonly.js";
import * as storeReads from "./session-meta-store.js";
import { writeAcpSessionMetaForMigration } from "./session-meta.js";

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

it("joins cold config, main aliases, and complete session fields without host SQL", async () => {
  await withOpenClawTestState({ label: "acp-singular-cold" }, async (state) => {
    const storePath = state.path("custom.sqlite");
    const cfg = {
      agents: { ownership: "explicit" as const, entries: { main: {} } },
      session: { store: storePath },
    };
    await state.writeConfig(cfg);
    const sessionKey = "agent:main:main";
    await replaceSessionEntry(
      { agentId: "main", storePath, sessionKey, env: state.env },
      {
        sessionId: "session",
        lifecycleRevision: "original",
        updatedAt: 100,
        skillsSnapshot: { prompt: "Saved instructions", skills: [{ name: "fixture" }] },
      },
    );
    writeAcpSessionMetaForMigration({
      env: state.env,
      sessionKey: buildAcpDatabaseSessionKey(sessionKey, "main"),
      lifecycleRevision: "original",
      meta,
    });
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
    resetConfigRuntimeState();
    const sql = observeMainThreadSql();
    try {
      const result = await readAcpSessionEntryAsync({ sessionKey: " main ", agentId: "main" });
      expect(result).toMatchObject({
        sessionKey: "main",
        storeSessionKey: sessionKey,
        agentId: "main",
        storePath,
        entry: {
          sessionId: "session",
          lifecycleRevision: "original",
          skillsSnapshot: { prompt: "Saved instructions", skills: [{ name: "fixture" }] },
        },
        acp: meta,
      });
      expect(await readAcpSessionMetaAsync({ sessionKey, agentId: "main" })).toEqual(meta);
      sql.expectIdle();
    } finally {
      sql.restore();
    }
  });
});

it("preserves missing-entry alias precedence and unreadable-store results without creating stores", async () => {
  await withOpenClawTestState({ label: "acp-singular-missing" }, async (state) => {
    const storePath = state.path("absent", "custom.sqlite");
    const sessionKey = "agent:main:acp:missing";
    const input = { cfg: { session: { store: storePath } }, env: state.env, sessionKey };
    writeAcpSessionMetaForMigration({ env: state.env, sessionKey, meta });
    expect(await readAcpSessionEntryAsync(input)).toMatchObject({
      sessionKey,
      entry: undefined,
      acp: meta,
    });
    expect(fs.existsSync(path.dirname(storePath))).toBe(false);

    // A bound primary row wins selection, then fails its missing-entry fence.
    // An empty binding object would incorrectly skip it and reveal the raw alias.
    writeAcpSessionMetaForMigration({
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
    writeAcpSessionMetaForMigration({ env: state.env, sessionKey: legacyKey, meta });
    expect(await readAcpSessionEntryAsync({ ...input, sessionKey: legacyKey })).toMatchObject({
      storeReadFailed: true,
      entry: undefined,
      acp: meta,
    });
  });
});

it.each(["caller", "store", "config"] as const)(
  "rejects a retired %s while the metadata join is held",
  async (retired) => {
    await withOpenClawTestState({ label: "acp-singular-retirement" }, async (state) => {
      const storePath = state.path("custom.sqlite");
      const sessionKey = "agent:main:acp:held";
      const cfg = { session: { store: storePath } };
      if (retired === "config") {
        await state.writeConfig(cfg);
        resetConfigRuntimeState();
      }
      await replaceSessionEntry(
        { agentId: "main", storePath, sessionKey, env: state.env },
        { sessionId: "held", lifecycleRevision: "original", updatedAt: 100 },
      );
      writeAcpSessionMetaForMigration({
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
        ...(retired === "config" ? {} : { cfg }),
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
        } else if (retired === "config") {
          await withEnvAsync(
            { OPENCLAW_CONFIG_PATH: state.path("replacement-config.json") },
            async () => {
              release.resolve();
              await rejected;
            },
          );
          return;
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

it("keeps the native incognito join together without creating an agent file", async () => {
  await withOpenClawTestState({ label: "acp-singular-incognito" }, async (state) => {
    const sessionKey = "agent:main:dashboard:incognito-private";
    const cfg = { agents: { ownership: "explicit" as const, entries: { main: {} } } };
    await replaceSessionEntry(
      { agentId: "main", sessionKey, env: state.env },
      { sessionId: "private", lifecycleRevision: "original", updatedAt: 100 },
    );
    const databaseKey = buildAcpDatabaseSessionKey(sessionKey, "main");
    writeAcpSessionMetaForMigration({
      env: state.env,
      sessionKey: databaseKey,
      lifecycleRevision: "original",
      meta,
    });
    const read = storeReads.readSessionEntryFromStore;
    vi.spyOn(storeReads, "readSessionEntryFromStore").mockImplementationOnce((input) => {
      const result = read(input);
      queueMicrotask(() => {
        writeAcpSessionMetaForMigration({
          env: state.env,
          sessionKey: databaseKey,
          lifecycleRevision: "replacement",
          meta: { ...meta, runtimeSessionName: "replacement-runtime" },
        });
      });
      return result;
    });
    expect(await readAcpSessionEntryAsync({ cfg, env: state.env, sessionKey })).toMatchObject({
      entry: { lifecycleRevision: "original" },
      acp: { runtimeSessionName: "original-runtime" },
    });
    expect(
      fs.existsSync(resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env: state.env })),
    ).toBe(false);
    expect(fs.existsSync(resolveOpenClawAgentSqlitePath({ agentId: "main", env: state.env }))).toBe(
      false,
    );
  });
});
