import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import type { SessionResetCommitContext } from "../../config/sessions/session-accessor.lifecycle-types.js";
import {
  loadSessionEntry,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.sqlite-entry.js";
import { resetSessionEntryLifecycle } from "../../config/sessions/session-accessor.sqlite-lifecycle.js";
import { memorySessionActorOwners } from "../../config/sessions/session-actor-memory-owner.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { sessionChanges, type SessionRowFacts } from "../../sessions/session-row-changes.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import {
  resolveIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.paths.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { seedCanonicalAcpSessionMeta } from "./session-meta-fixture.test-support.js";
import { createAcpMeta, interceptAcpCommit } from "./session-meta-lifecycle.test-support.js";
import { readAcpSessionMetaForEntry } from "./session-meta-readonly.js";
import { rebindDurableAcpSessionMetaAfterReset } from "./session-meta-reset.js";

const withState = (label: string, run: (state: OpenClawTestState) => Promise<void>) =>
  withOpenClawTestState({ scenario: "minimal", label }, run);

it("retains incognito reset context until its memory owner closes", () =>
  withState("incognito-reset-context", async (state) => {
    const f = await fixture(state, true);
    let captured: SessionResetCommitContext | undefined;
    const sql = observeHostDataSql();
    try {
      const reset = await resetSessionEntryLifecycle({
        ...f.reset,
        async afterEntryMutation(_mutation, context) {
          captured = context;
          context.assertCurrent();
          await Promise.resolve();
          context.assertCurrent();
        },
      });
      expect(reset.nextEntry.sessionId).toBe("private-reset");
      expect(loadSessionEntry(f.scope)).toMatchObject(f.entry);
      expect(captured?.source).toEqual(f.source);
      expect(() => captured!.assertCurrent()).not.toThrow();
      memorySessionActorOwners.closeDatabase(f.source);
      expect(() => captured!.assertCurrent()).toThrow("Incognito session actor owner is closed");
      expect(sql.queries).toEqual([]);
    } finally {
      sql.restore();
    }
  }));

const META = createAcpMeta({
  agent: "fixture",
  runtimeSessionName: "reset-runtime",
  lastActivityAt: 200,
});

async function fixture(state: OpenClawTestState, incognito = false) {
  const cfg = { agents: { ownership: "explicit" as const, entries: { main: {} } } };
  if (!incognito) {
    await state.writeConfig(cfg);
    setRuntimeConfigSnapshot(cfg);
  }
  const scope = {
    agentId: "main",
    sessionKey: incognito ? "agent:main:dashboard:incognito-reset-context" : "agent:main:acp:reset",
    env: state.env,
  };
  const source = {
    agentId: scope.agentId,
    path: (incognito ? resolveIncognitoOpenClawAgentSqlitePath : resolveOpenClawAgentSqlitePath)(
      scope,
    ),
  };
  const previous: SessionEntry = incognito
    ? { sessionId: "private-session", updatedAt: 1 }
    : { sessionId: "same-session-id", lifecycleRevision: "before-reset", updatedAt: 100 };
  const entry: SessionEntry = incognito
    ? { sessionId: "private-reset", updatedAt: 2 }
    : { ...previous, lifecycleRevision: "after-reset", updatedAt: 200 };
  await replaceSessionEntry(scope, previous);
  if (!incognito) {
    seedCanonicalAcpSessionMeta({
      ...scope,
      lifecycleRevision: previous.lifecycleRevision,
      meta: META,
    });
  }
  return {
    scope,
    source,
    previous,
    entry,
    reset: {
      ...scope,
      storePath: source.path,
      target: { canonicalKey: scope.sessionKey, storeKeys: [scope.sessionKey] },
      buildNextEntry: () => entry,
    },
    read: (selected: SessionEntry) => readAcpSessionMetaForEntry({ ...scope, entry: selected }),
  };
}

it.each([
  [false, false],
  [false, true],
  [true, false],
  [true, true],
])(
  "rebinds and publishes the reset receipt (native owner: %s, lost reply: %s)",
  (native, loseReply) =>
    withState("acp-reset-receipt", async (state) => {
      const f = await fixture(state);
      if (native) {
        openOpenClawAgentDatabase({ ...f.source, env: state.env });
      }
      const publications: SessionRowFacts[] = [];
      const unsubscribe = sessionChanges.subscribeFacts((change) => {
        if (
          "sessionKey" in change &&
          change.sessionKey === f.scope.sessionKey &&
          change.scope === "acp" &&
          change.facts
        ) {
          publications.push(change.facts);
        }
      });
      const commit = vi.fn(async (execute: () => Promise<unknown>) => {
        const value = await execute();
        if (loseReply) {
          throw new Error("synthetic shared worker reply lost after COMMIT");
        }
        return value;
      });
      const intercepted = interceptAcpCommit(commit);
      const afterEntryMutation = vi.fn<
        NonNullable<Parameters<typeof resetSessionEntryLifecycle>[0]["afterEntryMutation"]>
      >(async (mutation, context) => {
        const sql = observeHostDataSql();
        try {
          await rebindDurableAcpSessionMetaAfterReset({
            ...f.scope,
            context,
            entry: mutation.nextEntry,
            meta: META,
          });
        } finally {
          sql.restore();
          expect(sql.queries).toEqual([]);
        }
      });
      try {
        const reset = resetSessionEntryLifecycle({ ...f.reset, afterEntryMutation });
        if (loseReply) {
          await expect(reset).rejects.toThrow("synthetic shared worker reply lost after COMMIT");
        } else {
          expect((await reset).nextEntry).toEqual(f.entry);
        }
        expect(afterEntryMutation).toHaveBeenCalledOnce();
        expect(commit).toHaveBeenCalledOnce();
        expect(publications).toEqual([
          {
            kind: "acp",
            sessionId: f.entry.sessionId,
            lifecycleRevision: f.entry.lifecycleRevision,
            sessionStartedAt: undefined,
            acp: META,
          },
        ]);
        expect(f.read(f.entry)).toEqual(META);
        expect(f.read(f.previous)).toBeUndefined();
      } finally {
        intercepted.mockRestore();
        unsubscribe();
      }
    }),
);

it.each(["foreign-lifecycle", "pinned-lifecycle", "in-process-writer", "authority"] as const)(
  "refuses reset metadata when %s changes while the shared worker request is pending",
  (replacement) =>
    withState("acp-reset-refusal", async (state) => {
      const f = await fixture(state);
      const native = openOpenClawAgentDatabase({ ...f.source, env: state.env });
      await resetSessionEntryLifecycle(f.reset);
      const reached = createDeferredCore();
      const release = createDeferredCore();
      const intercepted = interceptAcpCommit(async (execute) => {
        reached.resolve();
        await release.promise;
        return execute();
      });
      let live = true;
      const denied = new Error("synthetic reset authority revoked");
      const outcome = rebindDurableAcpSessionMetaAfterReset({
        ...f.scope,
        context: { source: f.source, env: state.env, assertCurrent() {} },
        entry: f.entry,
        meta: META,
        assertCurrent() {
          if (!live) {
            throw denied;
          }
        },
      }).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      const successor = { ...f.entry, lifecycleRevision: "foreign-successor" };
      const successorMeta = { ...META, runtimeSessionName: "foreign-runtime" };
      try {
        await awaitGateBeforeSettlement(
          reached.promise,
          outcome,
          "ACP reset settled before reaching the shared writer",
        );
        if (replacement === "authority") {
          live = false;
        } else if (replacement === "in-process-writer") {
          await replaceSessionEntry(f.scope, { ...f.entry, activeWriterRunId: "successor" });
        } else {
          if (replacement === "pinned-lifecycle") {
            native.db.exec("BEGIN");
            native.db
              .prepare("SELECT entry_json FROM session_nodes WHERE session_key = ?")
              .get(f.scope.sessionKey);
          }
          const foreign = new DatabaseSync(f.source.path);
          try {
            foreign.exec("BEGIN IMMEDIATE");
            foreign
              .prepare(
                "UPDATE session_nodes SET entry_json = json_set(entry_json, '$.lifecycleRevision', ?) WHERE session_key = ?",
              )
              .run(successor.lifecycleRevision, f.scope.sessionKey);
            foreign
              .prepare("UPDATE session_nodes SET entry_valid = 1 WHERE session_key = ?")
              .run(f.scope.sessionKey);
            foreign.exec("COMMIT");
          } finally {
            foreign.close();
          }
          seedCanonicalAcpSessionMeta({
            ...f.scope,
            lifecycleRevision: successor.lifecycleRevision,
            meta: successorMeta,
          });
        }
        release.resolve();
        const settled = await outcome;
        expect(settled.ok).toBe(false);
        if (!settled.ok) {
          expect(String(settled.error)).toMatch(
            replacement === "authority"
              ? /synthetic reset authority revoked/
              : /Canonical ACP session changed before/,
          );
        }
        expect(f.read(f.entry)).toBeUndefined();
        const foreign = replacement === "foreign-lifecycle" || replacement === "pinned-lifecycle";
        expect(f.read(foreign ? successor : f.previous)).toEqual(foreign ? successorMeta : META);
      } finally {
        if (native.db.isTransaction) {
          native.db.exec("ROLLBACK");
        }
        release.resolve();
        await outcome;
        intercepted.mockRestore();
      }
    }),
);
