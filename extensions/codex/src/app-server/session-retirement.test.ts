import { randomUUID } from "node:crypto";
import { setImmediate as nextTurn } from "node:timers/promises";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { legacyCodexConversationBindingId } from "../conversation-binding-data.js";
import {
  claimCodexAppServerLiveThread as claimThread,
  consumeCodexAppServerLiveThread as consumeThread,
  ensureCodexAppServerClientRuntime,
  hasCodexAppServerLiveThread as hasLiveThread,
  isCodexAppServerLiveThreadClaimed as isThreadClaimed,
} from "./client-runtime.js";
import { codexNativeSubagentMonitorRuntime } from "./native-subagent-monitor.js";
import {
  bindingStoreKey,
  createCodexAppServerBindingStore as createBindingStore,
  type CodexAppServerBindingStore as BindingStore,
  type StoredCodexAppServerBinding as StoredBinding,
} from "./session-binding.js";
import { createCodexTestBindingStateStore as createStateStore } from "./session-binding.test-helpers.js";
import {
  withCodexAppServerSessionDeletion as withSessionDeletion,
  withCodexAppServerSessionContextReset as withContextReset,
} from "./session-retirement.js";
import * as sharedClients from "./shared-client.js";
import { createClientHarness } from "./test-support.js";
import {
  retainCodexAppServerBindingSubscription as retainSubscription,
  withCodexAppServerThreadMutation as withThreadMutation,
  withExclusiveCodexAppServerThread as withExclusiveThread,
} from "./thread-ownership.js";
import { withTimeout } from "./timeout.js";

const session = {
  kind: "session" as const,
  agentId: "main",
  sessionKey: "agent:main:dashboard:retirement",
  sessionId: "session-before-deletion",
};

describe("Codex session deletion subscriptions", () => {
  const clients: ReturnType<typeof createClientHarness>[] = [];

  afterEach(() => {
    for (const harness of clients) {
      harness.client.close();
      harness.emitExit();
    }
    clients.length = 0;
    vi.restoreAllMocks();
  });

  async function createFixture(
    operation: "deletion" | "context reset" = "deletion",
    initialIdentity = session,
  ) {
    const retire = operation === "deletion" ? withSessionDeletion : withContextReset;
    const harness = createClientHarness();
    clients.push(harness);
    const { client } = harness;
    const values = new Map<string, StoredBinding>();
    const storedBindings = createBindingStore(createStateStore(values));
    // These cases own subscription ordering. The host native-binding suite owns
    // real worker deletion, compensation, and exact persisted-row authority.
    const bindingStore: BindingStore = {
      ...storedBindings,
      async withSessionDeletion(identity, assertCurrent, run) {
        assertCurrent();
        const key = bindingStoreKey(identity);
        const record = values.get(key);
        return run(storedBindings.read(identity), {
          commit() {
            assertCurrent();
            values.delete(key);
          },
          rollback() {
            assertCurrent();
            if (record) {
              values.set(key, record);
            }
          },
        });
      },
    };
    const binding = {
      threadId: `thread-${randomUUID()}`,
      clientId: client.getInstanceId(),
      cwd: "/repo",
    };
    const request = vi.spyOn(client, "request").mockResolvedValue({ status: "unsubscribed" });
    const releaseClientLease = vi.fn();
    vi.spyOn(sharedClients, "retainSharedCodexAppServerClientByInstanceId").mockImplementation(
      async (clientId) =>
        clientId === binding.clientId ? { client, release: releaseClientLease } : undefined,
    );
    ensureCodexAppServerClientRuntime(client, {
      agentDir: "/tmp/codex-retirement-agent",
      authMode: "prepared-api-key",
    });

    const seed = async (identity = session) => {
      await bindingStore.mutate(identity, { kind: "set", binding });
    };
    const remove = (
      identity = session,
      run: Parameters<typeof withSessionDeletion<void>>[2] = async (mutation) => {
        mutation.commit();
      },
    ) => retire(bindingStore, { ...identity, assertCurrent: () => {} }, run);
    const resume = async (identity: typeof session) => {
      await bindingStore.withLease(identity, async () => {
        await client.request("thread/resume", { threadId: binding.threadId });
        await retainSubscription(client, binding.threadId);
        if (!(await bindingStore.mutate(identity, { kind: "set", binding }))) {
          throw new Error("resumed binding did not commit");
        }
      });
    };
    await seed(initialIdentity);
    return { bindingStore, binding, client, remove, request, resume, seed, releaseClientLease };
  }

  it("context reset rejects a claimed native thread before invoking the session transaction", async () => {
    const { client, binding, remove, bindingStore, request } = await createFixture("context reset");
    await claimThread(client, binding.threadId);
    const transaction = vi.fn(async () => {});

    await expect(remove(session, transaction)).rejects.toThrow("claimed by active work");

    expect(transaction).not.toHaveBeenCalled();
    expect(bindingStore.read(session)).toEqual(binding);
    expect(isThreadClaimed(client, binding.threadId)).toBe(true);
    expect(request).not.toHaveBeenCalled();
  });

  it("context reset joins native child settlement before releasing its subscription and client lease", async () => {
    const { client, binding, remove, bindingStore, request, releaseClientLease } =
      await createFixture("context reset");
    await retainSubscription(client, binding.threadId);
    const retiring = createDeferred<void>();
    const childSettlement = createDeferred<void>();
    const retire = vi
      .spyOn(codexNativeSubagentMonitorRuntime, "retireParent")
      .mockImplementation(async () => {
        retiring.resolve();
        await childSettlement.promise;
      });
    const deletion = remove();
    const settled = Promise.allSettled([deletion]);
    try {
      await withTimeout(retiring.promise, 5_000, "session cleanup did not retire native children");
      await nextTurn();
      expect(retire).toHaveBeenCalledExactlyOnceWith(client, binding.threadId);
      expect(bindingStore.read(session)).toBeUndefined();
      expect(hasLiveThread(client, binding.threadId)).toBe(true);
      expect(request).not.toHaveBeenCalled();
      expect(releaseClientLease).not.toHaveBeenCalled();

      childSettlement.resolve();
      await withTimeout(deletion, 5_000, "session cleanup did not join native child settlement");
      expect(request).toHaveBeenCalledExactlyOnceWith(
        "thread/unsubscribe",
        { threadId: binding.threadId },
        { timeoutMs: 5_000, assertCurrent: expect.any(Function) },
      );
      expect(hasLiveThread(client, binding.threadId)).toBe(false);
      expect(releaseClientLease).toHaveBeenCalledOnce();
    } finally {
      childSettlement.resolve();
      await withTimeout(settled, 5_000, "native retirement test cleanup did not settle");
    }
  });

  it("removes a migrated session binding without unsubscribing its surviving legacy conversation", async () => {
    const { bindingStore, binding, client, remove, request } = await createFixture();
    const conversation = {
      kind: "conversation" as const,
      bindingId: legacyCodexConversationBindingId("/repo/legacy-session.jsonl"),
    };
    await bindingStore.mutate(conversation, { kind: "set", binding });
    await retainSubscription(client, binding.threadId);

    await remove();

    expect(bindingStore.read(session)).toBeUndefined();
    expect(bindingStore.read(conversation)).toEqual(binding);
    expect(await consumeThread(client, binding.threadId)).toBeDefined();
    expect(request).not.toHaveBeenCalled();
  });

  it("preserves a same-key successor when resume owns the native queue before deletion cleanup", async () => {
    const { client, binding, resume, remove, bindingStore, request } = await createFixture();
    await retainSubscription(client, binding.threadId);
    const successor = { ...session, sessionId: "session-after-deletion" };
    const resumeEntered = createDeferred<void>();
    const allowResume = createDeferred<void>();
    const committed = createDeferred<void>();
    const resuming = withThreadMutation(binding.threadId, async () => {
      resumeEntered.resolve();
      await allowResume.promise;
      await resume(successor);
    });
    await withTimeout(resumeEntered.promise, 5_000, "resume did not enter the native queue");
    const deletion = remove(session, async (mutation) => {
      mutation.commit();
      committed.resolve();
    });
    const completion = Promise.allSettled([resuming, deletion]);
    try {
      await withTimeout(committed.promise, 5_000, "native resume queue blocked session deletion");
      allowResume.resolve();
      expect(
        await withTimeout(completion, 5_000, "native deletion cleanup did not settle"),
      ).toEqual([
        { status: "fulfilled", value: undefined },
        { status: "fulfilled", value: undefined },
      ]);
      expect(bindingStore.read(successor)).toEqual(binding);
      expect(await consumeThread(client, binding.threadId)).toBeDefined();
      expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/resume"]);
    } finally {
      allowResume.resolve();
      await withTimeout(completion, 5_000, "resume and deletion cleanup did not settle");
    }
  });

  it("context reset holds the native queue through unsubscribe acknowledgement before a successor resumes", async () => {
    const { client, binding, request, remove, bindingStore, resume } =
      await createFixture("context reset");
    await retainSubscription(client, binding.threadId);
    const unsubscribeStarted = createDeferred<void>();
    const unsubscribeAcknowledged = createDeferred<void>();
    request.mockImplementation(async (method) => {
      if (method === "thread/unsubscribe") {
        unsubscribeStarted.resolve();
        await unsubscribeAcknowledged.promise;
      }
      return {};
    });
    const deletion = remove();
    const deletionCompletion = Promise.allSettled([deletion]);
    let resuming: Promise<void> | undefined;
    try {
      await withTimeout(unsubscribeStarted.promise, 5_000, "deletion did not unsubscribe");
      const successor = { ...session, sessionId: "session-after-deletion" };
      let resumeEntered = false;
      resuming = withExclusiveThread({
        bindingStore,
        identity: successor,
        threadId: binding.threadId,
        run: async () => {
          resumeEntered = true;
          await resume(successor);
        },
      });
      const completion = Promise.allSettled([deletion, resuming]);
      await withThreadMutation(`other-${binding.threadId}`, async () => {});
      expect(resumeEntered).toBe(false);
      expect(bindingStore.read(session)).toBeUndefined();
      unsubscribeAcknowledged.resolve();
      expect(
        await withTimeout(completion, 5_000, "resume did not follow deletion cleanup"),
      ).toEqual([
        { status: "fulfilled", value: undefined },
        { status: "fulfilled", value: undefined },
      ]);
      expect(request.mock.calls.map(([method]) => method)).toEqual([
        "thread/unsubscribe",
        "thread/resume",
      ]);
      expect(bindingStore.read(successor)).toEqual(binding);
      expect(hasLiveThread(client, binding.threadId)).toBe(true);
    } finally {
      unsubscribeAcknowledged.resolve();
      await withTimeout(
        Promise.allSettled([deletionCompletion, resuming]),
        5_000,
        "unsubscribe and resume cleanup did not settle",
      );
    }
  });

  it("deletes nested same-thread owners without deadlock and releases their subscription once", async () => {
    const { seed, client, binding, remove, bindingStore, request } = await createFixture();
    const sibling = { ...session, sessionKey: "agent:main:cron:retirement:run:child" };
    await seed(sibling);
    await retainSubscription(client, binding.threadId);

    await withTimeout(
      remove(session, async (first) => {
        await remove(sibling, async (second) => {
          first.commit();
          second.commit();
        });
      }),
      5_000,
      "nested deletion deadlocked on a shared native thread",
    );

    expect(bindingStore.read(session)).toBeUndefined();
    expect(bindingStore.read(sibling)).toBeUndefined();
    expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/unsubscribe"]);
    expect(hasLiveThread(client, binding.threadId)).toBe(false);
  });

  it("restores a prepared predecessor binding and subscription when a context cut rolls back", async () => {
    const { client, binding, bindingStore, request } = await createFixture("context reset");
    await retainSubscription(client, binding.threadId);
    await expect(
      withContextReset(
        bindingStore,
        {
          ...session,
          sessionId: "session-after-compaction",
          previousSessionId: session.sessionId,
          assertCurrent() {},
        },
        async (mutation) => {
          mutation.commit();
          expect(bindingStore.read(session)).toBeUndefined();
          mutation.rollback();
          throw new Error("local transcript transaction rolled back");
        },
      ),
    ).rejects.toThrow("local transcript transaction rolled back");
    expect(bindingStore.read(session)).toEqual(binding);
    expect(hasLiveThread(client, binding.threadId)).toBe(true);
    expect(request).not.toHaveBeenCalled();
  });

  it("unsubscribes an incognito thread without an idle registry entry", async () => {
    const incognito = { ...session, sessionKey: "agent:main:dashboard:incognito-retirement" };
    const { remove, bindingStore, request, binding } = await createFixture("deletion", incognito);

    await remove(incognito);

    expect(bindingStore.read(incognito)).toBeUndefined();
    expect(request).toHaveBeenCalledExactlyOnceWith(
      "thread/unsubscribe",
      { threadId: binding.threadId },
      { timeoutMs: 5_000, assertCurrent: expect.any(Function) },
    );
  });
});
