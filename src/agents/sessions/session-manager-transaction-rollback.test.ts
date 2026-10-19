import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import {
  createSessionEntryWithTranscript,
  loadTranscriptEventsSync,
  resolveSessionTranscriptDatabasePath,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { SessionManager } from "./session-manager.js";

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
  if (!created.ok) {
    throw new Error("Session fixture was not created");
  }
  return { ...target, sessionId: created.entry.sessionId };
}

async function createPair(state: OpenClawTestState) {
  const first = await createTarget(state, "first");
  const second = await createTarget(state, "second");
  const manager = SessionManager.open(first, state.workspaceDir);
  manager.appendMessage(message("first seed"));
  const other = SessionManager.open(second, state.workspaceDir);
  const seed = other.appendMessage(message("second seed"));
  return {
    first,
    second,
    manager,
    other,
    seed,
    firstView: view(manager),
    secondView: view(other),
    firstRows: loadTranscriptEventsSync(first),
    secondRows: loadTranscriptEventsSync(second),
  };
}

function message(content: string) {
  return { role: "user" as const, content, timestamp: 1 };
}

type Target = Awaited<ReturnType<typeof createTarget>>;
function transactionOptions(target: Target) {
  return {
    agentId: target.agentId,
    env: target.env,
    path: resolveSessionTranscriptDatabasePath(target),
  };
}

function expectRollback(target: Target, refusal: Error, run: () => void) {
  let caught: unknown;
  try {
    runOpenClawAgentWriteTransaction(() => {
      run();
      throw refusal;
    }, transactionOptions(target));
  } catch (error) {
    caught = error;
  }
  expect(caught).toBe(refusal);
}

function expectReopened(manager: SessionManager, target: Target) {
  expect(view(manager)).toEqual(view(SessionManager.open(target)));
}

function view(manager: SessionManager) {
  return structuredClone({
    entries: manager.getEntries(),
    branch: manager.getBranch(),
    tree: manager.getTree(),
    context: manager.buildSessionContext(),
    leafId: manager.getLeafId(),
    appendParentId: manager.getAppendParentId(),
    appendMode: manager.getAppendMode(),
    boundaryCount: manager.getBoundaryCount(),
  });
}

it.each(["keyed replay", "same-target reload", "bounded branch", "lazy header"] as const)(
  "restores the live view and continuation after %s rolls back",
  async (scenario) => {
    await withOpenClawTestState({ label: "manager-transaction-rollback" }, async (state) => {
      setRuntimeConfigSnapshot({});
      const lazy = scenario === "lazy header";
      const bounded = scenario === "bounded branch";
      const target = await createTarget(state, scenario.replaceAll(" ", "-"), lazy);
      if (lazy) {
        expect(loadTranscriptEventsSync(target)).toEqual([]);
      }
      const writer = SessionManager.open(target, state.workspaceDir);
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
        ? await SessionManager.openBoundedAsync(target, limits)
        : lazy
          ? await SessionManager.openAsync(target, state.workspaceDir)
          : SessionManager.open(target, state.workspaceDir);
      if (bounded) {
        expect(manager.getEntry(expectDefined(omitted, "omitted entry"))).toBeUndefined();
        manager.branch(expectDefined(seed, "branch point"));
      }
      const before = view(manager);
      const durableBefore = loadTranscriptEventsSync(target);
      const header = structuredClone(manager.getHeader());
      const refusal = new Error("refuse enclosing transaction");
      expectRollback(target, refusal, () => {
        if (scenario === "keyed replay") {
          const keyed = { ...message("keyed user"), idempotencyKey: "replayed-user" };
          const keyedId = writer.appendMessage(keyed);
          expect(manager.appendMessageWithTranscriptAnchor(keyed)).toMatchObject({
            entryId: keyedId,
            appended: false,
          });
          expect(manager.getBranch()).toMatchObject([
            { id: seed, message: { content: "seed" } },
            { id: keyedId, parentId: seed, message: { content: "keyed user" } },
          ]);
        } else if (scenario === "same-target reload") {
          const provisional = manager.appendMessage(message("provisional"));
          manager.reloadPersistedTranscript();
          expect(manager.getBranch()).toMatchObject([
            { id: seed, message: { content: "seed" } },
            { id: provisional, parentId: seed, message: { content: "provisional" } },
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
      expect(loadTranscriptEventsSync(target)).toEqual(durableBefore);
      expect(view(manager)).toEqual(before);
      if (bounded) {
        expect(manager.getEntry(expectDefined(omitted, "omitted entry"))).toBeUndefined();
      } else if (lazy) {
        expect(loadTranscriptEventsSync(target)).toEqual([]);
        expect(manager.getHeader()).toEqual(header);
      } else {
        expectReopened(manager, target);
      }
      const content = lazy ? "committed retry" : bounded ? "new branch" : "after rollback";
      const next = manager.appendMessage(message(content));
      expect(manager.getEntry(next)?.parentId).toBe(seed);
      const reopened = SessionManager.open(target);
      if (bounded) {
        expect(reopened.buildSessionContext().messages).toMatchObject([
          { content: "older durable row" },
          { content: "selected branch point" },
          { content: "new branch" },
        ]);
      } else {
        if (lazy) {
          expect(loadTranscriptEventsSync(target)).toMatchObject([
            { type: "session", id: target.sessionId, cwd: state.workspaceDir },
            { type: "message", id: next, parentId: null, message: { content: "committed retry" } },
          ]);
          expect(reopened.getHeader()).toEqual(header);
        }
        expect(view(manager)).toEqual(view(reopened));
      }
    });
  },
);

it("rolls back only the inner savepoint while the enclosing transaction commits", async () => {
  await withOpenClawTestState({ label: "manager-savepoint-rollback" }, async (state) => {
    setRuntimeConfigSnapshot({});
    const target = await createTarget(state, "savepoint");
    const manager = SessionManager.open(target, state.workspaceDir);
    const seed = manager.appendMessage(message("seed"));
    const refusal = new Error("refuse inner savepoint");
    runOpenClawAgentWriteTransaction(() => {
      const retained = manager.appendMessage(message("retained outer write"));
      const before = view(manager);
      expectRollback(target, refusal, () => {
        manager.appendMessage(message("rolled back inner write"));
      });
      expect(view(manager)).toEqual(before);
      expectReopened(manager, target);
      const next = manager.appendMessage(message("outer continuation"));
      expect(manager.getEntry(next)?.parentId).toBe(retained);
    }, transactionOptions(target));
    expect(manager.getBranch()).toMatchObject([
      { id: seed, message: { content: "seed" } },
      { parentId: seed, message: { content: "retained outer write" } },
      { message: { content: "outer continuation" } },
    ]);
    expectReopened(manager, target);
  });
});

it("does not restore the old view over a rebound target after rollback", async () => {
  await withOpenClawTestState({ label: "manager-rebound-rollback" }, async (state) => {
    setRuntimeConfigSnapshot({});
    const { first, second, manager, other, seed, firstView, secondView } = await createPair(state);
    const refusal = new Error("refuse old target transaction");
    expectRollback(first, refusal, () => {
      manager.appendMessage(message("rolled back first write"));
      manager.setSessionTarget(second);
      expect(view(manager)).toEqual(secondView);
    });
    expect(manager.getSessionTarget()).toEqual(other.getSessionTarget());
    expect(manager.getSessionId()).toBe(second.sessionId);
    expect(view(manager)).toEqual(secondView);
    expect(view(SessionManager.open(first))).toEqual(firstView);
    const next = manager.appendMessage(message("second continuation"));
    expect(manager.getEntry(next)?.parentId).toBe(seed);
    expectReopened(manager, second);
  });
});

it.each(["top-level", "enclosing transaction"] as const)(
  "rejects a callback target rebind before persisting the message in a %s append",
  async (transaction) => {
    await withOpenClawTestState({ label: "manager-callback-rebind" }, async (state) => {
      setRuntimeConfigSnapshot({});
      const { first, second, manager, other, seed, firstRows, secondRows, secondView } =
        await createPair(state);
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
      if (transaction === "enclosing transaction") {
        // Catch inside the transaction so its COMMIT cannot mask a late append rejection.
        runOpenClawAgentWriteTransaction(appendAndCatch, transactionOptions(first));
      } else {
        appendAndCatch();
      }
      expect(rebound).toBe(true);
      expect(caught).toMatchObject({ name: "SessionTranscriptWriterClaimReboundError" });
      expect(loadTranscriptEventsSync(first)).toEqual(firstRows);
      expect(loadTranscriptEventsSync(second)).toEqual(secondRows);
      expect(manager.getSessionTarget()).toEqual(other.getSessionTarget());
      expect(manager.getSessionId()).toBe(second.sessionId);
      expect(view(manager)).toEqual(secondView);
      const next = manager.appendMessage(message("second continuation"));
      expect(manager.getEntry(next)?.parentId).toBe(seed);
      expectReopened(manager, second);
    });
  },
);
