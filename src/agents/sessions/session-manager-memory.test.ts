import assert from "node:assert/strict";
import { afterEach, expect, it, vi } from "vitest";
import { makeUserMessage as userMessage } from "../../../test/helpers/user-message.js";
import { memorySessionActorOwners } from "../../config/sessions/session-actor-memory-owner.js";
import { createMemorySessionActorOwner } from "../../config/sessions/session-actor-memory.js";
import { runWithSessionActorStorage } from "../../config/sessions/session-actor-storage-binding.js";
import type { InitialSessionTranscriptWriter } from "../../config/sessions/session-transcript-writer.types.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { assistantText, expectCancelledReads } from "./session-manager-fixtures.test-support.js";
import { readSessionManagerModelContextAsync } from "./session-manager-incognito.js";
import { withSessionMetadataWorker } from "./session-manager-metadata-runtime.js";
import { receiveSessionManagerCommit } from "./session-manager-persistence-error.js";
import { withSessionManagerWrite } from "./session-manager-write-admission.js";
import { SessionManager } from "./session-manager.js";

vi.mock("node:sqlite", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:sqlite")>()),
  DatabaseSync: vi.fn(function () {
    throw new Error("Memory SessionManager opened SQLite");
  }),
}));
vi.mock("node:worker_threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:worker_threads")>()),
  Worker: vi.fn(function () {
    throw new Error("Memory SessionManager allocated a worker");
  }),
}));

const authority = { assertCurrent() {}, authorize() {} };
const lifetime = { assertCurrent() {}, assertReadable() {} };
const owners: ReturnType<typeof createMemorySessionActorOwner>[] = [];
const registryOwners: Array<{ agentId: string; path: string }> = [];
afterEach(() => {
  for (const options of registryOwners.splice(0)) {
    memorySessionActorOwners.closeDatabase(options);
  }
  for (const owner of owners.splice(0)) {
    owner.close();
  }
});

async function actorFixture(name: string, create = true) {
  const target = {
    agentId: "main",
    storePath: "/synthetic/session-manager-memory/incognito.sqlite",
    sessionKey: `agent:main:dashboard:incognito-${name}`,
    sessionId: name,
  };
  const owner = createMemorySessionActorOwner({ agentId: target.agentId, path: target.storePath });
  owners.push(owner);
  const actor = await owner.acquire(
    { database: owner.identity, sessionKey: target.sessionKey },
    lifetime,
  );
  assert(actor.storage, "Memory actor has no storage capability");
  if (create) {
    const created = await actor.storage.mutate(
      {
        type: "session.entry.create",
        input: { entry: { sessionId: name, updatedAt: 1 }, cwd: "/synthetic" },
      },
      authority,
    );
    expect(created.kind).toBe("committed");
  }
  const binding = { actor, authority, agentId: target.agentId, path: target.storePath };
  return {
    target,
    owner,
    actor,
    storage: actor.storage,
    binding,
    run: <T>(run: () => T) => runWithSessionActorStorage(binding, run),
  };
}

function readMessages(target: Parameters<typeof SessionManager.openAsync>[0]) {
  return SessionManager.readSessionContextAsync(target, (messages) => [...messages]);
}

async function fixture(name: string, create = true) {
  const actor = await actorFixture(name, create);
  const manager = await actor.run(() => SessionManager.openAsync(actor.target));
  return {
    ...actor,
    manager,
    read: () => actor.run(() => readMessages(actor.target)),
    context: (options?: Parameters<typeof SessionManager.openModelContextAsync>[1]) =>
      actor.run(() => SessionManager.openModelContextAsync(actor.target, options)),
  };
}

it("retains its selected owner for ordered writes and reads current transcript state without SQLite", async () => {
  const { target, run, read, owner, manager } = await fixture("ordered");
  const messages = [userMessage("first", 1), userMessage("second", 2)];
  const [firstId, secondId] = await Promise.all(
    messages.map((message) => manager.appendMessageAsync(message)),
  );
  assert(firstId && secondId, "Missing fixture message entries");
  expect(manager.getBranch()).toMatchObject([
    { type: "message", id: firstId },
    { type: "message", id: secondId, parentId: firstId },
  ]);
  await manager.appendThinkingLevelChange("high");
  const reopened = await run(() => SessionManager.openAsync(target));
  expect(reopened.buildSessionContext()).toMatchObject({ messages, thinkingLevel: "high" });
  expect(await read()).toEqual(messages);
  expect(
    (await readSessionManagerModelContextAsync(target, {}, (context) => context, manager)).events,
  ).toMatchObject(reopened.getPersistedEntries());
  owner.close();
  await expect(manager.appendMessageAsync(userMessage("closed", 3))).rejects.toThrow(/closed/);
});

it("opens an empty selected actor and initializes it on the first message", async () => {
  const { target, storage, manager } = await fixture("empty", false);
  expect(manager.getEntries()).toEqual([]);
  const messageId = await manager.appendMessageAsync(userMessage("first input", 1));
  expect(await storage.read({ type: "session.entry.read", input: {} }, authority)).toMatchObject({
    sessionId: target.sessionId,
    incognito: true,
  });
  expect(manager.getBranch()).toMatchObject([{ id: messageId, type: "message" }]);
});

it("adopts its branch's new actor window and keeps subsequent writes on that owner", async () => {
  const { target, storage, manager } = await fixture("branch");
  const first = await manager.appendMessageAsync(userMessage("retained", 1));
  assert(first, "Missing fixture branch entry");
  await manager.appendMessageAsync(userMessage("omitted", 2));
  await manager.createBranchedSession(first);
  const nextTarget = manager.getSessionTarget()!;
  expect(nextTarget.sessionId).not.toBe(target.sessionId);
  const next = await manager.appendMessageAsync(userMessage("new branch", 3));
  expect(manager.getBranch().map((entry) => entry.id)).toEqual([first, next]);
  const current = await storage.acquire(target.sessionKey);
  expect(
    await current.storage!.read({ type: "session.history.context-messages", input: {} }, authority),
  ).toMatchObject({
    messages: [userMessage("retained", 1), userMessage("new branch", 3)],
  });
  await current.release();
});

it("keeps a detached context snapshot while an in-process append becomes visible on the next read", async () => {
  const { target, run, read, manager } = await fixture("snapshot");
  const first = userMessage("captured", 1);
  const later = userMessage("later", 2);
  await manager.appendMessageAsync(first);
  await expect(
    run(() =>
      SessionManager.readSessionContextAsync(target, async (messages) => {
        const captured = [...messages];
        await manager.appendMessageAsync(later);
        return captured;
      }),
    ),
  ).resolves.toEqual([first]);
  expect(await read()).toEqual([first, later]);
});

it("cancels context reads without preventing the next read", async () => {
  const { context: readContext, manager } = await fixture("context-abort");
  await manager.appendMessageAsync(userMessage("retained context", 1));
  await expectCancelledReads((signal) => readContext({ signal }));
  const context = await readContext();
  expect(context.isPersisted()).toBe(false);
  expect(context.buildSessionContext()).toEqual(manager.buildSessionContext());
});

it("keeps a completed-turn snapshot while a later rewrite invalidates its anchor for new reads", async () => {
  const { context: readContext, manager } = await fixture("completed-context");
  await manager.appendMessageAsync(userMessage("completed question", 1));
  const terminal = await manager.appendMessageWithTranscriptAnchorAsync(
    assistantText("completed answer"),
  );
  assert(terminal.anchor, "Missing completed-turn anchor");
  const expected = manager.buildSessionContext();
  await manager.appendMessageAsync(userMessage("later question", 2));
  const context = await readContext({ through: terminal.anchor });
  expect(context.buildSessionContext()).toEqual(expected);
  await manager.removeTrailingEntriesAsync((entry) => entry.type === "message");
  expect(context.buildSessionContext()).toEqual(expected);
  await expect(readContext({ through: terminal.anchor })).rejects.toThrow(/transcript|anchor/i);
});

it("drains accepted manager work on release while preserving manager-local order", async () => {
  const { actor, run, manager } = await fixture("release");
  const entered = createDeferredCore();
  const finish = createDeferredCore();
  const writing = run(() =>
    withSessionManagerWrite(manager, async () => {
      entered.resolve();
      await finish.promise;
      return manager.appendMessageAsync(userMessage("accepted", 1));
    }),
  );
  await entered.promise;
  const released = actor.release();
  finish.resolve();
  const entryId = await writing;
  await released;
  assert(entryId, "Missing accepted message entry");
  expect(manager.getEntry(entryId)).toMatchObject({ message: { content: "accepted" } });
});

it.each(["agent:main:dashboard:incognito-unbound", "agent:main:dashboard:ordinary-unbound"])(
  "opens and reopens unbound %s at an explicit memory path without SQLite",
  async (sessionKey) => {
    const env = { OPENCLAW_STATE_DIR: "/synthetic/session-manager-unbound" };
    const options = {
      agentId: "main",
      path: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env }),
    };
    registryOwners.push(options);
    const target = {
      agentId: "main",
      storePath: options.path,
      env,
      sessionKey,
      sessionId: "unbound",
    };
    expect(await readMessages(target)).toEqual([]);
    const manager = await SessionManager.openAsync(target);
    expect(manager.getEntries()).toEqual([]);
    const bounded = await SessionManager.openBoundedAsync(target, { maxBytes: 4096, maxEvents: 5 });
    const context = await SessionManager.openModelContextAsync(target);
    expect(bounded.getEntries()).toEqual([]);
    expect(context.buildSessionContext().messages).toEqual([]);
    expect(context.isPersisted()).toBe(false);
    expect(memorySessionActorOwners.read(options)).toBeUndefined();
    const first = userMessage("unbound first", 1);
    const writer = await SessionManager.openAsync(target);
    await writer.appendMessageAsync(first);
    const reopened = await SessionManager.openAsync(target);
    expect(reopened.buildSessionContext().messages).toEqual([first]);
    await manager.reloadPersistedTranscriptAsync();
    await bounded.reloadPersistedTranscriptAsync();
    expect(manager.buildSessionContext().messages).toEqual([first]);
    expect(bounded.buildSessionContext().messages).toEqual([first]);
    const owner = memorySessionActorOwners.read(options)!;
    expect(owner.readSession(target.sessionKey, authority)?.entry).toMatchObject({
      sessionId: target.sessionId,
      incognito: true,
    });
    const second = userMessage("manager second", 2);
    await manager.appendMessageAsync(second);
    await bounded.reloadPersistedTranscriptAsync();
    expect(bounded.buildSessionContext().messages).toEqual([first, second]);
    expect(await readMessages(target)).toEqual([first, second]);
    expect(() => SessionManager.open(target)).toThrow(/Async/);
    memorySessionActorOwners.closeDatabase(options);
    await expect(manager.reloadPersistedTranscriptAsync()).rejects.toThrow(/closed/);
  },
);

it("keeps the owner after the opening caller releases and releases operation handles on failure", async () => {
  const { actor, target, run, owner, storage } = await actorFixture("operation-lifetime");
  const acquired: Awaited<ReturnType<typeof storage.acquire>>[] = [];
  const acquire = storage.acquire.bind(storage);
  vi.spyOn(storage, "acquire").mockImplementation(async (...args) => {
    const handle = await acquire(...args);
    acquired.push(handle);
    return handle;
  });
  const manager = await run(() => SessionManager.openAsync(target));
  await actor.release();
  await expect(
    withSessionManagerWrite(manager, async () => {
      throw new Error("operation failed");
    }),
  ).rejects.toThrow("operation failed");
  expect(acquired.length).toBeGreaterThan(0);
  for (const handle of acquired) {
    expect(() => handle.assertReadable()).toThrow(/released/);
  }
  const id = await manager.appendMessageAsync(userMessage("after caller release", 1));
  assert(id, "Missing message entry after caller release");
  expect(manager.getEntry(id)).toMatchObject({ message: { content: "after caller release" } });
  owner.close();
  await expect(manager.appendMessageAsync(userMessage("after owner close", 2))).rejects.toThrow(
    /closed/,
  );
});

it("keeps caller revocation at context disclosure and subsequent manager writes", async () => {
  const { target, binding } = await actorFixture("caller-revocation");
  let revoked = false;
  const scoped = {
    ...binding,
    authority: {
      authorize() {},
      assertCurrent() {
        if (revoked) {
          throw new Error("Transport closed");
        }
      },
    },
  };
  const manager = await runWithSessionActorStorage(scoped, () => SessionManager.openAsync(target));
  await manager.appendMessageAsync(userMessage("private", 1));
  await expect(
    runWithSessionActorStorage(scoped, () =>
      SessionManager.readSessionContextAsync(target, async (messages) => {
        const captured = [...messages];
        revoked = true;
        return captured;
      }),
    ),
  ).rejects.toThrow("Transport closed");
  await expect(manager.appendMessageAsync(userMessage("refused", 2))).rejects.toThrow(
    "Transport closed",
  );
});

it("retains a committed initial-writer receipt when its host publication throws", async () => {
  const { target, run, storage } = await actorFixture("initial", false);
  const manager = { getSessionTarget: () => target, getSessionId: () => target.sessionId };
  let fence: InitialSessionTranscriptWriter["committedFence"];
  const initialWriter: InitialSessionTranscriptWriter = {
    writerRunId: "writer-1",
    get committedFence() {
      return fence;
    },
    assertActive() {},
    withTranscriptWrite: async (operation) => operation(),
    recordCommitted(value) {
      fence = value;
      throw new Error("initial writer publication failed");
    },
  };
  const receipt = await run(() =>
    withSessionManagerWrite(manager, async (admission) => {
      assert(admission, "Missing write admission");
      return receiveSessionManagerCommit("session.metadata.initialize", () =>
        withSessionMetadataWorker(
          admission.options,
          admission.database,
          () => admission.assertCurrent(),
          (worker) =>
            worker.execute({
              type: "session.metadata.initialize",
              input: {
                scope: target,
                entry: { sessionId: target.sessionId, updatedAt: 1 },
                initialWriterRunId: initialWriter.writerRunId,
              },
            }),
          { initialWriter },
        ),
      );
    }),
  );
  expect(receipt.value).toMatchObject({
    owned: true,
    fence: { expectedWriterRunId: "writer-1" },
  });
  expect(receipt.failure?.cause).toMatchObject({ message: "initial writer publication failed" });
  expect(await storage.read({ type: "session.entry.read", input: {} }, authority)).toMatchObject({
    activeWriterRunId: "writer-1",
  });
  expect(fence).toEqual(receipt.value.fence);
});
