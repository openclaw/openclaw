import { afterEach, describe, expect, it, vi } from "vitest";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import { createMemorySessionActorOwner } from "../../config/sessions/session-actor-memory.js";
import { runWithSessionActorStorage } from "../../config/sessions/session-actor-storage-binding.js";
import type { InitialSessionTranscriptWriter } from "../../config/sessions/session-transcript-writer.types.js";
import { createDeferredCore } from "../../shared/deferred.js";
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
afterEach(() => {
  for (const owner of owners.splice(0)) {
    owner.close();
  }
});

async function fixture(name: string, create = true) {
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
  if (!actor.storage) {
    throw new Error("Memory actor has no storage capability");
  }
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

describe("SessionManager selected memory actor", () => {
  it("retains its selected owner for ordered writes and reads current transcript state without SQLite", async () => {
    const { target, run, owner } = await fixture("ordered");
    const manager = await run(() => SessionManager.openAsync(target));
    const messages = [makeUserMessage("first", 1), makeUserMessage("second", 2)];
    const [firstId, secondId] = await Promise.all(
      messages.map((message) => manager.appendMessageAsync(message)),
    );
    expect(
      manager
        .getBranch()
        .filter((entry) => entry.type === "message")
        .map((entry) => entry.id),
    ).toEqual([firstId, secondId]);
    expect(manager.getEntry(secondId)?.parentId).toBe(firstId);
    await manager.appendThinkingLevelChange("high");
    const reopened = await run(() => SessionManager.openAsync(target));
    expect(reopened.buildSessionContext()).toMatchObject({ messages, thinkingLevel: "high" });
    expect(
      await run(() => SessionManager.readSessionContextAsync(target, (current) => [...current])),
    ).toEqual(messages);
    expect(
      (await readSessionManagerModelContextAsync(target, {}, (context) => context, manager)).events,
    ).toEqual(reopened.getPersistedEntries());
    owner.close();
    await expect(manager.appendMessageAsync(makeUserMessage("closed", 3))).rejects.toThrow(
      /closed/,
    );
  });

  it("opens an empty selected actor and initializes it on the first message", async () => {
    const { target, run, storage } = await fixture("empty", false);
    const manager = await run(() => SessionManager.openAsync(target));
    expect(manager.getEntries()).toEqual([]);
    const messageId = await manager.appendMessageAsync(makeUserMessage("first input", 1));
    expect(await storage.read({ type: "session.entry.read", input: {} }, authority)).toMatchObject({
      sessionId: target.sessionId,
      incognito: true,
    });
    expect(manager.getBranch()).toMatchObject([{ id: messageId, type: "message" }]);
  });

  it("adopts its branch's new actor window and keeps subsequent writes on that owner", async () => {
    const { target, run, storage } = await fixture("branch");
    const manager = await run(() => SessionManager.openAsync(target));
    const first = await manager.appendMessageAsync(makeUserMessage("retained", 1));
    await manager.appendMessageAsync(makeUserMessage("omitted", 2));
    await manager.createBranchedSession(first);
    const nextTarget = manager.getSessionTarget()!;
    expect(nextTarget.sessionId).not.toBe(target.sessionId);
    const next = await manager.appendMessageAsync(makeUserMessage("new branch", 3));
    expect(manager.getBranch().map((entry) => entry.id)).toEqual([first, next]);
    const current = await storage.acquire(target.sessionKey);
    expect(
      await current.storage!.read(
        { type: "session.history.context-messages", input: {} },
        authority,
      ),
    ).toMatchObject({
      messages: [makeUserMessage("retained", 1), makeUserMessage("new branch", 3)],
    });
    await current.release();
  });

  it("keeps a detached context snapshot while an in-process append becomes visible on the next read", async () => {
    const { target, run } = await fixture("snapshot");
    const manager = await run(() => SessionManager.openAsync(target));
    const first = makeUserMessage("captured", 1);
    const later = makeUserMessage("later", 2);
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
    expect(
      await run(() => SessionManager.readSessionContextAsync(target, (messages) => [...messages])),
    ).toEqual([first, later]);
  });

  it("drains accepted manager work on release while preserving manager-local order", async () => {
    const { actor, target, run } = await fixture("release");
    const manager = await run(() => SessionManager.openAsync(target));
    const entered = createDeferredCore();
    const finish = createDeferredCore();
    const writing = withSessionManagerWrite(manager, async () => {
      entered.resolve();
      await finish.promise;
      return manager.appendMessageAsync(makeUserMessage("accepted", 1));
    });
    await entered.promise;
    const released = actor.release();
    finish.resolve();
    const entryId = await writing;
    await released;
    expect(manager.getEntry(entryId)).toMatchObject({ message: { content: "accepted" } });
  });

  it("retains a committed initial-writer receipt when its host publication throws", async () => {
    const { target, run, storage } = await fixture("initial", false);
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
        if (!admission) {
          throw new Error("Missing write admission");
        }
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
});
