import assert from "node:assert/strict";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import {
  createSessionEntryWithTranscript,
  loadTranscriptEventsSync as readEvents,
  resolveSessionTranscriptDatabasePath as databasePath,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { runOpenClawAgentWriteTransaction as transaction } from "../../state/openclaw-agent-db.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { SessionManager as Manager } from "./session-manager.js";

async function createTarget(state: OpenClawTestState, name: string, lazy = false) {
  const scope = {
    agentId: "main",
    env: state.env,
    sessionKey: `agent:main:dashboard:${name}`,
  };
  const target = {
    ...scope,
    sessionId: name,
    storePath: resolveSessionStorePathCore(undefined, scope),
  };
  if (lazy) {
    await upsertSessionEntryCore(target, { sessionId: name, updatedAt: 1 });
    return target;
  }
  const created = await createSessionEntryWithTranscript(
    scope,
    () => ({ ok: true as const, entry: { sessionId: name, updatedAt: 1 } }),
    { cwd: state.workspaceDir },
  );
  assert(created.ok, "Session fixture was not created");
  return { ...target, sessionId: created.entry.sessionId };
}

const message = (content: string) => ({ role: "user" as const, content, timestamp: 1 });
type Target = Awaited<ReturnType<typeof createTarget>>;
const dbOptions = (t: Target) => ({ agentId: t.agentId, env: t.env, path: databasePath(t) });

function expectRollback(target: Target, run: () => void) {
  const refusal = new Error("refuse transaction");
  assert.throws(
    () =>
      transaction(() => {
        run();
        throw refusal;
      }, dbOptions(target)),
    (error) => error === refusal,
  );
}

const view = (manager: Manager) =>
  structuredClone({
    entries: manager.getEntries(),
    branch: manager.getBranch(),
    tree: manager.getTree(),
    context: manager.buildSessionContext(),
    leafId: manager.getLeafId(),
    appendParentId: manager.getAppendParentId(),
    appendMode: manager.getAppendMode(),
    boundaryCount: manager.getBoundaryCount(),
  });

it.each(["keyed replay", "same-target reload", "bounded branch", "lazy header"] as const)(
  "restores the live view and continuation after %s rolls back",
  (scenario) =>
    withOpenClawTestState({ label: "manager-transaction-rollback" }, async (state) => {
      setRuntimeConfigSnapshot({});
      const lazy = scenario === "lazy header";
      const bounded = scenario === "bounded branch";
      const target = await createTarget(state, scenario.replaceAll(" ", "-"), lazy);
      if (lazy) {
        expect(readEvents(target)).toEqual([]);
      }
      const writer = Manager.open(target, state.workspaceDir);
      let seed: string | null = null;
      let omitted: string | undefined;
      if (bounded) {
        omitted = writer.appendMessage(message("older durable row"));
        seed = writer.appendMessage(message("selected branch point"));
        writer.appendMessage(message("unselected tail"));
      } else if (!lazy) {
        seed = writer.appendMessage(message("seed"));
      }
      const limits = { cwd: state.workspaceDir, maxEvents: 2, maxBytes: 65536 };
      const manager = bounded
        ? await Manager.openBoundedAsync(target, limits)
        : lazy
          ? await Manager.openAsync(target, state.workspaceDir)
          : Manager.open(target, state.workspaceDir);
      if (bounded) {
        expect(manager.getEntry(expectDefined(omitted, "omitted entry"))).toBeUndefined();
        manager.branch(expectDefined(seed, "branch point"));
      }
      const before = view(manager);
      const durableBefore = readEvents(target);
      const header = structuredClone(manager.getHeader());
      expectRollback(target, () => {
        if (!bounded && !lazy) {
          const replay = scenario === "keyed replay";
          const entry = replay
            ? { ...message("keyed user"), idempotencyKey: "replayed-user" }
            : message("provisional");
          const id = (replay ? writer : manager).appendMessage(entry);
          if (replay) {
            expect(manager.appendMessageWithTranscriptAnchor(entry)).toMatchObject({
              entryId: id,
              appended: false,
            });
          } else {
            manager.reloadPersistedTranscript();
          }
          expect(manager.getBranch()).toMatchObject([
            { id: seed, message: { content: "seed" } },
            { id, parentId: seed, message: { content: entry.content } },
          ]);
        } else if (bounded) {
          const selected = expectDefined(seed, "branch point");
          manager.appendLabelChange(selected, "temporary label");
          const reset = manager.appendResetBoundary("reset", selected);
          manager.appendLeafControl({
            targetId: selected,
            appendParentId: reset,
            appendMode: "side",
          });
          expect(manager.getBoundaryCount()).toBe(before.boundaryCount + 1);
          expect(manager.getLabel(selected)).toBe("temporary label");
        } else {
          const rejected = manager.appendMessage(message("rolled back first message"));
          expect(manager.getEntry(rejected)?.parentId).toBeNull();
        }
      });
      expect(readEvents(target)).toEqual(durableBefore);
      expect(view(manager)).toEqual(before);
      if (bounded) {
        expect(manager.getEntry(expectDefined(omitted, "omitted entry"))).toBeUndefined();
      } else if (lazy) {
        expect(manager.getHeader()).toEqual(header);
      }
      const content = lazy ? "committed retry" : bounded ? "new branch" : "after rollback";
      const next = manager.appendMessage(message(content));
      expect(manager.getEntry(next)?.parentId).toBe(seed);
      const reopened = Manager.open(target);
      if (bounded) {
        expect(reopened.buildSessionContext().messages).toMatchObject([
          { content: "older durable row" },
          { content: "selected branch point" },
          { content: "new branch" },
        ]);
      } else {
        if (lazy) {
          expect(readEvents(target)).toMatchObject([
            { type: "session", id: target.sessionId, cwd: state.workspaceDir },
            { type: "message", id: next, parentId: null, message: { content: "committed retry" } },
          ]);
          expect(reopened.getHeader()).toEqual(header);
        }
        expect(view(manager)).toEqual(view(reopened));
      }
    }),
);

it("rolls back only the inner savepoint while the enclosing transaction commits", () =>
  withOpenClawTestState({ label: "manager-savepoint-rollback" }, async (state) => {
    setRuntimeConfigSnapshot({});
    const target = await createTarget(state, "savepoint");
    const manager = Manager.open(target, state.workspaceDir);
    const seed = manager.appendMessage(message("seed"));
    transaction(() => {
      const retained = manager.appendMessage(message("retained outer write"));
      const before = view(manager);
      expectRollback(target, () => {
        manager.appendMessage(message("rolled back inner write"));
      });
      expect(view(manager)).toEqual(before);
      expect(view(manager)).toEqual(view(Manager.open(target)));
      const next = manager.appendMessage(message("outer continuation"));
      expect(manager.getEntry(next)?.parentId).toBe(retained);
    }, dbOptions(target));
    expect(manager.getBranch()).toMatchObject([
      { id: seed, message: { content: "seed" } },
      { parentId: seed, message: { content: "retained outer write" } },
      { message: { content: "outer continuation" } },
    ]);
    expect(view(manager)).toEqual(view(Manager.open(target)));
  }));

it.each(["rollback", "top-level", "enclosing transaction"] as const)(
  "keeps the rebound target selected after %s rejection",
  (mode) =>
    withOpenClawTestState({ label: "manager-rebound-rejection" }, async (state) => {
      setRuntimeConfigSnapshot({});
      const first = await createTarget(state, "first");
      const second = await createTarget(state, "second");
      const manager = Manager.open(first, state.workspaceDir);
      manager.appendMessage(message("first seed"));
      const other = Manager.open(second, state.workspaceDir);
      const seed = other.appendMessage(message("second seed"));
      const firstView = view(manager);
      const secondView = view(other);
      if (mode === "rollback") {
        expectRollback(first, () => {
          manager.appendMessage(message("rolled back first write"));
          manager.setSessionTarget(second);
          expect(view(manager)).toEqual(secondView);
        });
        expect(view(Manager.open(first))).toEqual(firstView);
      } else {
        const firstRows = readEvents(first);
        const secondRows = readEvents(second);
        let rebound = false;
        let caught: unknown;
        const appendAndCatch = () => {
          try {
            manager.appendMessage(message("rejected first-target write"), {
              beforeFreshMessageCommit: () => {
                manager.setSessionTarget(second);
                rebound = true;
              },
            });
          } catch (error) {
            caught = error;
          }
        };
        if (mode === "enclosing transaction") {
          // Catch before COMMIT so it cannot mask a late append rejection.
          transaction(appendAndCatch, dbOptions(first));
        } else {
          appendAndCatch();
        }
        expect(rebound).toBe(true);
        expect(caught).toMatchObject({ name: "SessionTranscriptWriterClaimReboundError" });
        expect(readEvents(first)).toEqual(firstRows);
        expect(readEvents(second)).toEqual(secondRows);
      }
      expect(manager.getSessionTarget()).toEqual(other.getSessionTarget());
      expect(manager.getSessionId()).toBe(second.sessionId);
      expect(view(manager)).toEqual(secondView);
      const next = manager.appendMessage(message("second continuation"));
      expect(manager.getEntry(next)?.parentId).toBe(seed);
      expect(view(manager)).toEqual(view(Manager.open(second)));
    }),
);
