import { randomUUID } from "node:crypto";
import { setImmediate as nextTurn } from "node:timers/promises";
import { AgentHarnessPreflightError } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, expect, it, vi } from "vitest";
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
const successor = { ...session, sessionId: "session-after-deletion" };
const wait = <T>(promise: Promise<T>, message: string) => withTimeout(promise, 5_000, message);
async function expectCompleted(completion: Promise<PromiseSettledResult<void>[]>) {
  expect(await wait(completion, "native deletion cleanup did not settle")).toEqual([
    { status: "fulfilled", value: undefined },
    { status: "fulfilled", value: undefined },
  ]);
}

const clients: ReturnType<typeof createClientHarness>[] = [];

afterEach(() => {
  for (const harness of clients) {
    harness.client.close();
    harness.emitExit();
  }
  clients.length = 0;
  vi.restoreAllMocks();
});

async function fixture(retire = withSessionDeletion, initialIdentity = session, subscribed = true) {
  const harness = createClientHarness();
  clients.push(harness);
  const { client } = harness;
  const values = new Map<string, StoredBinding>();
  const storedBindings = createBindingStore(createStateStore(values));
  // These cases own subscription ordering. The host native-binding suite owns
  // real worker deletion, compensation, and exact persisted-row authority.
  const store: BindingStore = {
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
  const release = vi.fn();
  vi.spyOn(sharedClients, "retainSharedCodexAppServerClientByInstanceId").mockImplementation(
    async (clientId) => (clientId === binding.clientId ? { client, release } : undefined),
  );
  ensureCodexAppServerClientRuntime(client, {
    agentDir: "/tmp/codex-retirement-agent",
    authMode: "prepared-api-key",
  });

  const seed = async (identity = session) => {
    await store.mutate(identity, { kind: "set", binding });
  };
  const remove = (
    identity = session,
    run: Parameters<typeof withSessionDeletion<void>>[2] = async (mutation) => {
      mutation.commit();
    },
    previousSessionId?: string,
  ) => {
    const params = { ...identity, previousSessionId, assertCurrent: () => {} };
    return retire(store, params, run);
  };
  const resume = (identity: typeof session) =>
    store.withLease(identity, async () => {
      await client.request("thread/resume", { threadId: binding.threadId });
      await retainSubscription(client, binding.threadId);
      if (!(await store.mutate(identity, { kind: "set", binding }))) {
        throw new Error("resumed binding did not commit");
      }
    });
  await seed(initialIdentity);
  if (subscribed) {
    await retainSubscription(client, binding.threadId);
  }
  const expectUnsubscribe = () =>
    expect(request).toHaveBeenCalledExactlyOnceWith(
      "thread/unsubscribe",
      { threadId: binding.threadId },
      { timeoutMs: 5_000, assertCurrent: expect.any(Function) },
    );
  return { store, binding, client, remove, request, resume, seed, release, expectUnsubscribe };
}

it("context reset rejects a claimed native thread before invoking the session transaction", async () => {
  const f = await fixture(withContextReset, session, false);
  await claimThread(f.client, f.binding.threadId);
  const transaction = vi.fn(async () => {});

  const deletion = f.remove(session, transaction);
  await expect(deletion).rejects.toBeInstanceOf(AgentHarnessPreflightError);
  await expect(deletion).rejects.toThrow("claimed by active work");

  expect(transaction).not.toHaveBeenCalled();
  expect(f.store.read(session)).toEqual(f.binding);
  expect(isThreadClaimed(f.client, f.binding.threadId)).toBe(true);
  expect(f.request).not.toHaveBeenCalled();
});

it("context reset joins native child settlement before releasing its subscription and client lease", async () => {
  const f = await fixture(withContextReset);
  const retiring = createDeferred<void>();
  const childSettlement = createDeferred<void>();
  const retire = vi
    .spyOn(codexNativeSubagentMonitorRuntime, "retireParent")
    .mockImplementation(async () => {
      retiring.resolve();
      await childSettlement.promise;
    });
  const deletion = f.remove();
  const settled = Promise.allSettled([deletion]);
  try {
    await wait(retiring.promise, "session cleanup did not retire native children");
    await nextTurn();
    expect(retire).toHaveBeenCalledExactlyOnceWith(f.client, f.binding.threadId);
    expect(f.store.read(session)).toBeUndefined();
    expect(hasLiveThread(f.client, f.binding.threadId)).toBe(true);
    expect(f.request).not.toHaveBeenCalled();
    expect(f.release).not.toHaveBeenCalled();

    childSettlement.resolve();
    await wait(deletion, "session cleanup did not join native child settlement");
    f.expectUnsubscribe();
    expect(hasLiveThread(f.client, f.binding.threadId)).toBe(false);
    expect(f.release).toHaveBeenCalledOnce();
  } finally {
    childSettlement.resolve();
    await wait(settled, "native retirement test cleanup did not settle");
  }
});

it("removes a migrated session binding without unsubscribing its surviving legacy conversation", async () => {
  const f = await fixture();
  const conversation = {
    kind: "conversation" as const,
    bindingId: legacyCodexConversationBindingId("/repo/legacy-session.jsonl"),
  };
  await f.store.mutate(conversation, { kind: "set", binding: f.binding });

  await f.remove();

  expect(f.store.read(session)).toBeUndefined();
  expect(f.store.read(conversation)).toEqual(f.binding);
  expect(await consumeThread(f.client, f.binding.threadId)).toBeDefined();
  expect(f.request).not.toHaveBeenCalled();
});

it.each(["resume-first", "unsubscribe-first"])(
  "preserves the successor with %s queue ownership",
  async (order) => {
    const resumeFirst = order === "resume-first";
    const f = await fixture(resumeFirst ? withSessionDeletion : withContextReset);
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    const committed = createDeferred<void>();
    if (!resumeFirst) {
      f.request.mockImplementation(async (method) => {
        if (method === "thread/unsubscribe") {
          entered.resolve();
          await release.promise;
        }
        return {};
      });
    }
    const first = resumeFirst
      ? withThreadMutation(f.binding.threadId, async () => {
          entered.resolve();
          await release.promise;
          await f.resume(successor);
        })
      : f.remove();
    let completion: Promise<PromiseSettledResult<void>[]> = Promise.allSettled([first]);
    try {
      await wait(entered.promise, `${order} operation did not enter the native queue`);
      let resumeEntered = false;
      const second = resumeFirst
        ? f.remove(session, async (mutation) => {
            mutation.commit();
            committed.resolve();
          })
        : withExclusiveThread({
            bindingStore: f.store,
            identity: successor,
            threadId: f.binding.threadId,
            run: async () => {
              resumeEntered = true;
              await f.resume(successor);
            },
          });
      completion = Promise.allSettled([first, second]);
      if (resumeFirst) {
        await wait(committed.promise, "native resume queue blocked session deletion");
      } else {
        await withThreadMutation(`other-${f.binding.threadId}`, async () => {});
        expect(resumeEntered).toBe(false);
        expect(f.store.read(session)).toBeUndefined();
      }
      release.resolve();
      await expectCompleted(completion);
      expect(f.request.mock.calls.map(([method]) => method)).toEqual(
        resumeFirst ? ["thread/resume"] : ["thread/unsubscribe", "thread/resume"],
      );
      expect(f.store.read(successor)).toEqual(f.binding);
      expect(hasLiveThread(f.client, f.binding.threadId)).toBe(true);
      if (resumeFirst) {
        expect(await consumeThread(f.client, f.binding.threadId)).toBeDefined();
      }
    } finally {
      release.resolve();
      await wait(completion, "resume and deletion cleanup did not settle");
    }
  },
);

it("deletes nested same-thread owners without deadlock and releases their subscription once", async () => {
  const f = await fixture();
  const sibling = { ...session, sessionKey: "agent:main:cron:retirement:run:child" };
  await f.seed(sibling);

  await wait(
    f.remove(session, async (first) => {
      await f.remove(sibling, async (second) => {
        first.commit();
        second.commit();
      });
    }),
    "nested deletion deadlocked on a shared native thread",
  );

  expect(f.store.read(session)).toBeUndefined();
  expect(f.store.read(sibling)).toBeUndefined();
  expect(f.request.mock.calls.map(([method]) => method)).toEqual(["thread/unsubscribe"]);
  expect(hasLiveThread(f.client, f.binding.threadId)).toBe(false);
});

it("restores a prepared predecessor binding and subscription when a context cut rolls back", async () => {
  const f = await fixture(withContextReset);
  await expect(
    f.remove(
      { ...session, sessionId: "session-after-compaction" },
      async (mutation) => {
        mutation.commit();
        expect(f.store.read(session)).toBeUndefined();
        mutation.rollback();
        throw new Error("local transcript transaction rolled back");
      },
      session.sessionId,
    ),
  ).rejects.toThrow("local transcript transaction rolled back");
  expect(f.store.read(session)).toEqual(f.binding);
  expect(hasLiveThread(f.client, f.binding.threadId)).toBe(true);
  expect(f.request).not.toHaveBeenCalled();
});

it("unsubscribes an incognito thread without an idle registry entry", async () => {
  const incognito = { ...session, sessionKey: "agent:main:dashboard:incognito-retirement" };
  const f = await fixture(withSessionDeletion, incognito, false);

  await f.remove(incognito);

  expect(f.store.read(incognito)).toBeUndefined();
  f.expectUnsubscribe();
});
