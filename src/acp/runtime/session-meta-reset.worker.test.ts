import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import type { SessionResetCommitContext } from "../../config/sessions/session-accessor.lifecycle-types.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { resetSessionEntryLifecycle } from "../../config/sessions/session-accessor.sqlite-lifecycle.js";
import type { SessionAcpMeta, SessionEntry } from "../../config/sessions/types.js";
import { sessionChanges, type SessionRowFacts } from "../../sessions/session-row-changes.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import {
  resolveIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.paths.js";
import * as stateWorker from "../../state/openclaw-state-worker-store.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { seedCanonicalAcpSessionMeta } from "./session-meta-fixture.test-support.js";
import { readAcpSessionMetaForEntry } from "./session-meta-readonly.js";
import { rebindDurableAcpSessionMetaAfterReset } from "./session-meta-reset.js";

it("retains native incognito reset context only through its callback", async () => {
  await withOpenClawTestState(
    { scenario: "minimal", label: "incognito-reset-context" },
    async (state) => {
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:dashboard:incognito-reset-context",
        env: state.env,
      };
      await replaceSessionEntry(scope, { sessionId: "private-session", updatedAt: 1 });
      let captured: SessionResetCommitContext | undefined;
      const reset = await resetSessionEntryLifecycle({
        agentId: scope.agentId,
        storePath: resolveIncognitoOpenClawAgentSqlitePath(scope),
        target: { canonicalKey: scope.sessionKey, storeKeys: [scope.sessionKey] },
        buildNextEntry: () => ({ sessionId: "private-reset", updatedAt: 2 }),
        async afterEntryMutation(_mutation, context) {
          captured = context;
          context.assertCurrent();
          await Promise.resolve();
          context.assertCurrent();
        },
      });
      expect(reset.nextEntry.sessionId).toBe("private-reset");
      expect(captured).toBeDefined();
      expect(() => captured!.assertCurrent()).toThrow("claim is no longer current");
    },
  );
});

const META: SessionAcpMeta = {
  backend: "fixture",
  agent: "fixture",
  runtimeSessionName: "reset-runtime",
  mode: "persistent",
  state: "idle",
  lastActivityAt: 200,
};

async function fixture(state: OpenClawTestState) {
  const cfg = { agents: { ownership: "explicit" as const, entries: { main: {} } } };
  await state.writeConfig(cfg);
  const scope = { agentId: "main", sessionKey: "agent:main:acp:reset", env: state.env };
  const source = {
    agentId: "main",
    path: resolveOpenClawAgentSqlitePath({ agentId: "main", env: state.env }),
  };
  const previous: SessionEntry = {
    sessionId: "same-session-id",
    lifecycleRevision: "before-reset",
    updatedAt: 100,
  };
  const entry: SessionEntry = { ...previous, lifecycleRevision: "after-reset", updatedAt: 200 };
  await replaceSessionEntry(scope, previous);
  seedCanonicalAcpSessionMeta({
    ...scope,
    lifecycleRevision: previous.lifecycleRevision,
    meta: META,
  });
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

function interceptCommit(intercept: (execute: () => Promise<unknown>) => Promise<unknown>) {
  const original = stateWorker.runOpenClawStateWorkerOperation;
  return vi
    .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
    .mockImplementation((context, operation, options) =>
      original(
        context,
        (worker) =>
          operation({
            ...worker,
            execute: new Proxy(worker.execute, {
              apply(execute, receiver, args: Parameters<typeof worker.execute>) {
                const run = () => Reflect.apply(execute, receiver, args);
                return args[0].type === "acp.commitMutation" ? intercept(run) : run();
              },
            }),
          }),
        options,
      ),
    );
}

it.each([
  { native: false, loseReply: false },
  { native: false, loseReply: true },
  { native: true, loseReply: false },
  { native: true, loseReply: true },
])(
  "rebinds and publishes the reset receipt (native owner: $native, lost reply: $loseReply)",
  async ({ native, loseReply }) => {
    await withOpenClawTestState(
      { scenario: "minimal", label: "acp-reset-receipt" },
      async (state) => {
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
        const intercepted = interceptCommit(commit);
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
            // Preparation is observable too, but only executions count toward the SQL budget.
            expect(
              sql.calls.slice(1).reduce((count, call) => count + call.mock.calls.length, 0),
            ).toBe(native ? 2 : 0);
            expect(sql.queries.every((query) => query.includes('from "session_nodes"'))).toBe(true);
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
      },
    );
  },
);

it.each(["foreign-lifecycle", "pinned-lifecycle", "authority"] as const)(
  "refuses reset metadata when %s changes while the shared worker request is pending",
  async (replacement) => {
    await withOpenClawTestState(
      { scenario: "minimal", label: "acp-reset-refusal" },
      async (state) => {
        const f = await fixture(state);
        const native = openOpenClawAgentDatabase({ ...f.source, env: state.env });
        await resetSessionEntryLifecycle(f.reset);
        const reached = createDeferredCore();
        const release = createDeferredCore();
        const intercepted = interceptCommit(async (execute) => {
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
              // Certify the valid foreign postimage as an independent session writer would.
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
          expect(f.read(replacement === "authority" ? f.previous : successor)).toEqual(
            replacement === "authority" ? META : successorMeta,
          );
        } finally {
          if (native.db.isTransaction) {
            native.db.exec("ROLLBACK");
          }
          release.resolve();
          await outcome;
          intercepted.mockRestore();
        }
      },
    );
  },
);
