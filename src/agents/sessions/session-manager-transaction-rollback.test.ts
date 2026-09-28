import { expect, it } from "vitest";
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

async function createTarget(state: OpenClawTestState, name: string, incognito = false) {
  const scope = {
    agentId: "main",
    env: state.env,
    sessionKey: `agent:main:dashboard:${incognito ? "incognito-" : ""}${name}`,
  };
  const created = await createSessionEntryWithTranscript(
    scope,
    () => ({
      ok: true as const,
      entry: { sessionId: name, updatedAt: 1, ...(incognito ? { incognito: true as const } : {}) },
    }),
    { cwd: state.workspaceDir },
  );
  if (!created.ok) {
    throw new Error("Session fixture was not created");
  }
  return {
    ...scope,
    sessionId: created.entry.sessionId,
    storePath: resolveSessionStorePathCore(undefined, scope),
  };
}

function message(content: string) {
  return { role: "user" as const, content, timestamp: 1 };
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

const callbackCases = (["openAsync", "openBoundedAsync"] as const).flatMap((opener) =>
  (["commit", "refusal"] as const).map((outcome) => ({ opener, outcome })),
);

it.each(callbackCases)(
  "$opener keeps reentrant incognito reads and the live view consistent after callback $outcome",
  async ({ opener, outcome }) => {
    await withOpenClawTestState({ label: "manager-callback-rollback" }, async (state) => {
      const target = await createTarget(state, "callback", true);
      const manager =
        opener === "openAsync"
          ? await SessionManager.openAsync(target, state.workspaceDir)
          : await SessionManager.openBoundedAsync(target, {
              cwd: state.workspaceDir,
              maxEvents: 20,
              maxBytes: 65536,
            });
      const seed = manager.appendMessage(message("seed"));
      const before = view(manager);
      const refusal = new Error("refuse outer append after nested write");
      let nested: string | undefined;
      let outer: string | undefined;
      let caught: unknown;
      try {
        outer = manager.appendMessage(message("outer"), {
          beforeFreshMessageCommit: () => {
            if (nested === undefined) {
              expect(
                SessionManager.open(target)
                  .getEntries()
                  .map((entry) => entry.id),
              ).toEqual([seed]);
              nested = manager.appendMessage(message("nested"));
            }
            expect(
              SessionManager.open(target)
                .getEntries()
                .map((entry) => entry.id),
            ).toEqual([seed, nested]);
            expect(manager.getAppendParentId()).toBe(nested);
            if (outcome === "refusal") {
              throw refusal;
            }
          },
        });
      } catch (error) {
        caught = error;
      }
      expect(nested).toBeTypeOf("string");
      expect(caught).toBe(outcome === "refusal" ? refusal : undefined);
      if (outcome === "refusal") {
        expect(outer).toBeUndefined();
        expect(view(SessionManager.open(target))).toEqual(before);
        expect(view(manager)).toEqual(before);
      } else {
        expect(outer).toBeTypeOf("string");
        expect(manager.getBranch()).toMatchObject([
          { id: seed, parentId: null, message: { content: "seed" } },
          { id: nested, parentId: seed, message: { content: "nested" } },
          { id: outer, parentId: nested, message: { content: "outer" } },
        ]);
        expect(view(manager)).toEqual(view(SessionManager.open(target)));
      }
      const next = manager.appendMessage(message("after settlement"));
      expect(manager.getEntry(next)?.parentId).toBe(outcome === "refusal" ? seed : outer);
      expect(view(manager)).toEqual(view(SessionManager.open(target)));
    });
  },
);

it("restores the prior view after replaying another writer's provisional keyed user", async () => {
  await withOpenClawTestState({ label: "manager-keyed-replay-rollback" }, async (state) => {
    const target = await createTarget(state, "keyed-replay");
    const writer = SessionManager.open(target, state.workspaceDir);
    const seed = writer.appendMessage(message("seed"));
    const manager = SessionManager.open(target, state.workspaceDir);
    const keyed = { ...message("keyed user"), idempotencyKey: "replayed-user" };
    const durableBefore = loadTranscriptEventsSync(target);
    const beforeReplay = view(manager);
    const refusal = new Error("refuse enclosing transaction after keyed replay");
    let caught: unknown;
    try {
      runOpenClawAgentWriteTransaction(
        () => {
          const keyedId = writer.appendMessage(keyed);
          const replay = manager.appendMessageWithTranscriptAnchor(keyed);
          expect(replay).toMatchObject({ entryId: keyedId, appended: false });
          expect(manager.getBranch()).toMatchObject([
            { id: seed, message: { content: "seed" } },
            { id: keyedId, parentId: seed, message: { content: "keyed user" } },
          ]);
          throw refusal;
        },
        {
          agentId: target.agentId,
          env: target.env,
          path: resolveSessionTranscriptDatabasePath(target),
        },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(refusal);
    expect(loadTranscriptEventsSync(target)).toEqual(durableBefore);
    expect(view(manager)).toEqual(beforeReplay);
    expect(view(manager)).toEqual(view(SessionManager.open(target)));
    const next = manager.appendMessage(message("after replay rollback"));
    expect(manager.getEntry(next)?.parentId).toBe(seed);
    expect(view(manager)).toEqual(view(SessionManager.open(target)));
  });
});

it("restores the live view while a callback-started hydration is still pending", async () => {
  await withOpenClawTestState({ label: "manager-pending-hydration-rollback" }, async (state) => {
    const target = await createTarget(state, "pending-hydration", true);
    const manager = await SessionManager.openAsync(target, state.workspaceDir);
    const seed = manager.appendMessage(message("seed"));
    const before = view(manager);
    const refusal = new Error("refuse outer append with hydration pending");
    const pending: Promise<unknown>[] = [];
    let outcomes: unknown[];
    let caught: unknown;
    try {
      try {
        manager.appendMessage(message("outer"), {
          beforeFreshMessageCommit: () => {
            manager.appendMessage(message("nested"));
            pending.push(
              manager.reloadPersistedTranscriptAsync().then(
                () => undefined,
                (error: unknown) => error,
              ),
            );
            throw refusal;
          },
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBe(refusal);
      expect(pending).toHaveLength(1);
      // Rollback must finish before the pending read gets a chance to publish.
      expect(view(manager)).toEqual(before);
      expect(view(SessionManager.open(target))).toEqual(before);
    } finally {
      outcomes = await Promise.all(pending);
    }
    expect(outcomes).toEqual([
      expect.objectContaining({ message: "Session manager changed during transcript hydration" }),
    ]);
    expect(view(manager)).toEqual(before);
    const next = manager.appendMessage(message("after hydration settles"));
    expect(manager.getEntry(next)?.parentId).toBe(seed);
    expect(view(manager)).toEqual(view(SessionManager.open(target)));
  });
});

it("restores the live view after a same-target reload observes a rolled-back append", async () => {
  await withOpenClawTestState({ label: "manager-reloaded-rollback" }, async (state) => {
    const target = await createTarget(state, "reloaded");
    const manager = SessionManager.open(target, state.workspaceDir);
    const seed = manager.appendMessage(message("seed"));
    const before = view(manager);
    const durableBefore = loadTranscriptEventsSync(target);
    const refusal = new Error("refuse transaction after same-target reload");
    let caught: unknown;
    try {
      runOpenClawAgentWriteTransaction(
        () => {
          const provisional = manager.appendMessage(message("provisional"));
          manager.reloadPersistedTranscript();
          expect(manager.getBranch()).toMatchObject([
            { id: seed, message: { content: "seed" } },
            { id: provisional, parentId: seed, message: { content: "provisional" } },
          ]);
          throw refusal;
        },
        {
          agentId: target.agentId,
          env: target.env,
          path: resolveSessionTranscriptDatabasePath(target),
        },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(refusal);
    expect(loadTranscriptEventsSync(target)).toEqual(durableBefore);
    expect(view(SessionManager.open(target))).toEqual(before);
    expect(view(manager)).toEqual(before);
    const next = manager.appendMessage(message("after rollback"));
    expect(manager.getEntry(next)?.parentId).toBe(seed);
    expect(view(manager)).toEqual(view(SessionManager.open(target)));
  });
});

it("restores a bounded deliberate branch when an enclosing transaction rolls back", async () => {
  await withOpenClawTestState({ label: "manager-bounded-rollback" }, async (state) => {
    const target = await createTarget(state, "bounded");
    const writer = SessionManager.open(target, state.workspaceDir);
    const omitted = writer.appendMessage(message("older durable row"));
    const selected = writer.appendMessage(message("selected branch point"));
    writer.appendMessage(message("unselected tail"));
    const manager = await SessionManager.openBoundedAsync(target, {
      cwd: state.workspaceDir,
      maxEvents: 2,
      maxBytes: 65536,
    });
    expect(manager.getEntry(omitted)).toBeUndefined();
    manager.branch(selected);
    const before = view(manager);
    const durableBefore = loadTranscriptEventsSync(target);
    const refusal = new Error("refuse enclosing transaction");
    let caught: unknown;
    try {
      runOpenClawAgentWriteTransaction(
        () => {
          manager.appendLabelChange(selected, "temporary label");
          const reset = manager.appendResetBoundary("reset", selected);
          manager.appendLeafControl({
            targetId: selected,
            appendParentId: reset,
            appendMode: "side",
          });
          expect(manager.getBoundaryCount()).toBe(before.boundaryCount + 1);
          expect(manager.getLabel(selected)).toBe("temporary label");
          throw refusal;
        },
        {
          agentId: target.agentId,
          env: target.env,
          path: resolveSessionTranscriptDatabasePath(target),
        },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(refusal);
    expect(loadTranscriptEventsSync(target)).toEqual(durableBefore);
    expect(view(manager)).toEqual(before);
    expect(manager.getEntry(omitted)).toBeUndefined();
    const next = manager.appendMessage(message("new branch"));
    expect(manager.getEntry(next)?.parentId).toBe(selected);
    expect(SessionManager.open(target).buildSessionContext().messages).toMatchObject([
      { content: "older durable row" },
      { content: "selected branch point" },
      { content: "new branch" },
    ]);
  });
});

it("rolls back only the inner savepoint while the enclosing transaction commits", async () => {
  await withOpenClawTestState({ label: "manager-savepoint-rollback" }, async (state) => {
    const target = await createTarget(state, "savepoint");
    const manager = SessionManager.open(target, state.workspaceDir);
    const seed = manager.appendMessage(message("seed"));
    const options = {
      agentId: target.agentId,
      env: target.env,
      path: resolveSessionTranscriptDatabasePath(target),
    };
    const refusal = new Error("refuse inner savepoint");
    runOpenClawAgentWriteTransaction(() => {
      const retained = manager.appendMessage(message("retained outer write"));
      const before = view(manager);
      let caught: unknown;
      try {
        runOpenClawAgentWriteTransaction(() => {
          manager.appendMessage(message("rolled back inner write"));
          throw refusal;
        }, options);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBe(refusal);
      expect(view(manager)).toEqual(before);
      expect(view(manager)).toEqual(view(SessionManager.open(target)));
      const next = manager.appendMessage(message("outer continuation"));
      expect(manager.getEntry(next)?.parentId).toBe(retained);
    }, options);
    expect(manager.getBranch()).toMatchObject([
      { id: seed, message: { content: "seed" } },
      { parentId: seed, message: { content: "retained outer write" } },
      { message: { content: "outer continuation" } },
    ]);
    expect(view(manager)).toEqual(view(SessionManager.open(target)));
  });
});

it("does not restore the old view over a rebound target after rollback", async () => {
  await withOpenClawTestState({ label: "manager-rebound-rollback" }, async (state) => {
    const first = await createTarget(state, "first");
    const second = await createTarget(state, "second");
    const manager = SessionManager.open(first, state.workspaceDir);
    manager.appendMessage(message("first seed"));
    const firstBefore = view(manager);
    const secondWriter = SessionManager.open(second, state.workspaceDir);
    const secondSeed = secondWriter.appendMessage(message("second seed"));
    const secondBefore = view(secondWriter);
    const refusal = new Error("refuse old target transaction");
    let caught: unknown;
    try {
      runOpenClawAgentWriteTransaction(
        () => {
          manager.appendMessage(message("rolled back first write"));
          manager.setSessionTarget(second);
          expect(view(manager)).toEqual(secondBefore);
          throw refusal;
        },
        {
          agentId: first.agentId,
          env: first.env,
          path: resolveSessionTranscriptDatabasePath(first),
        },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(refusal);
    expect(manager.getSessionTarget()).toEqual(secondWriter.getSessionTarget());
    expect(manager.getSessionId()).toBe(second.sessionId);
    expect(view(manager)).toEqual(secondBefore);
    expect(view(SessionManager.open(first))).toEqual(firstBefore);
    const next = manager.appendMessage(message("second continuation"));
    expect(manager.getEntry(next)?.parentId).toBe(secondSeed);
    expect(view(manager)).toEqual(view(SessionManager.open(second)));
  });
});

it.each(["top-level", "enclosing transaction"] as const)(
  "rejects a callback target rebind before persisting the message in a %s append",
  async (transaction) => {
    await withOpenClawTestState({ label: "manager-callback-rebind" }, async (state) => {
      const first = await createTarget(state, "first");
      const second = await createTarget(state, "second");
      const manager = SessionManager.open(first, state.workspaceDir);
      manager.appendMessage(message("first seed"));
      const secondWriter = SessionManager.open(second, state.workspaceDir);
      const secondSeed = secondWriter.appendMessage(message("second seed"));
      const firstRows = loadTranscriptEventsSync(first);
      const secondRows = loadTranscriptEventsSync(second);
      const selectedView = view(secondWriter);
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
        runOpenClawAgentWriteTransaction(appendAndCatch, {
          agentId: first.agentId,
          env: first.env,
          path: resolveSessionTranscriptDatabasePath(first),
        });
      } else {
        appendAndCatch();
      }
      expect(rebound).toBe(true);
      expect(caught).toMatchObject({ name: "SessionTranscriptWriterClaimReboundError" });
      expect(loadTranscriptEventsSync(first)).toEqual(firstRows);
      expect(loadTranscriptEventsSync(second)).toEqual(secondRows);
      expect(manager.getSessionTarget()).toEqual(secondWriter.getSessionTarget());
      expect(manager.getSessionId()).toBe(second.sessionId);
      expect(view(manager)).toEqual(selectedView);
      const next = manager.appendMessage(message("second continuation"));
      expect(manager.getEntry(next)?.parentId).toBe(secondSeed);
      expect(view(manager)).toEqual(view(SessionManager.open(second)));
    });
  },
);

it("persists the lazy header on retry after its first append rolls back", async () => {
  await withOpenClawTestState({ label: "manager-lazy-header-rollback" }, async (state) => {
    const target = {
      agentId: "main",
      env: state.env,
      sessionKey: "agent:main:dashboard:lazy-header",
      sessionId: "lazy-header",
      storePath: resolveSessionStorePathCore(undefined, { agentId: "main", env: state.env }),
    };
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
    expect(loadTranscriptEventsSync(target)).toEqual([]);
    const manager = await SessionManager.openAsync(target, state.workspaceDir);
    const before = view(manager);
    const header = structuredClone(manager.getHeader());
    const refusal = new Error("refuse first append and lazy header");
    let caught: unknown;
    try {
      runOpenClawAgentWriteTransaction(
        () => {
          const rejected = manager.appendMessage(message("rolled back first message"));
          expect(manager.getEntry(rejected)?.parentId).toBeNull();
          throw refusal;
        },
        {
          agentId: target.agentId,
          env: target.env,
          path: resolveSessionTranscriptDatabasePath(target),
        },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(refusal);
    expect(loadTranscriptEventsSync(target)).toEqual([]);
    expect(manager.getHeader()).toEqual(header);
    expect(view(manager)).toEqual(before);
    const committed = manager.appendMessage(message("committed retry"));
    expect(loadTranscriptEventsSync(target)).toMatchObject([
      { type: "session", id: target.sessionId, cwd: state.workspaceDir },
      { type: "message", id: committed, parentId: null, message: { content: "committed retry" } },
    ]);
    const reopened = SessionManager.open(target);
    expect(reopened.getHeader()).toEqual(header);
    expect(view(manager)).toEqual(view(reopened));
  });
});
