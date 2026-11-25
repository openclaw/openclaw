import { setImmediate } from "node:timers/promises";
import { runWithAsyncWorkResources } from "openclaw/plugin-sdk/agent-harness-tool-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { expect, it, vi } from "vitest";
import { createCodexTestBindingStore } from "./session-binding.test-helpers.js";

async function loadOwners() {
  const first = await import("./thread-ownership.js");
  vi.resetModules();
  return [first, await import("./thread-ownership.js")] as const;
}

it.each(["thread", "conversation"] as const)(
  "shares %s ordering across module copies without blocking another key",
  async (scope) => {
    const [first, second] = await loadOwners();
    const method =
      scope === "thread"
        ? "withCodexAppServerThreadMutation"
        : "withCodexConversationThreadActivity";
    const activeOwner = first[method];
    const waitingOwner = second[method];
    expect(activeOwner).not.toBe(waitingOwner);
    const bindingStore = createCodexTestBindingStore();
    const identity = { kind: "session" as const, agentId: "main", sessionId: "shared-session" };
    const threadId = "shared-thread";
    const setBinding = (cwd: string) =>
      bindingStore.mutate(identity, {
        kind: "set",
        binding: { threadId, cwd },
      });
    await setBinding("/before");
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    const events: string[] = [];
    const active = activeOwner(threadId, async () => {
      events.push("active");
      entered.resolve();
      await release.promise;
      await setBinding("/after");
    });
    await entered.promise;
    const run = async () => {
      events.push("waiting");
      return bindingStore.read(identity);
    };
    const waiting =
      scope === "thread"
        ? second.withExclusiveCodexAppServerThread({ bindingStore, identity, threadId, run })
        : waitingOwner(threadId, run);
    const completed = Promise.all([active, waiting]);
    try {
      await waitingOwner("other-key", async () => {
        events.push("other");
      });
      expect(events).toEqual(["active", "other"]);
    } finally {
      release.resolve();
      await completed;
    }
    expect(events).toEqual(["active", "other", "waiting"]);
    await expect(waiting).resolves.toMatchObject({ threadId, cwd: "/after" });
  },
);

it("reserves a held lane immediately and retains authority after failure", async () => {
  const [owner, successor] = await loadOwners();
  const release = createDeferred<void>();
  const authorityReleased = createDeferred<void>();
  const releaseAuthority = vi.fn(() => authorityReleased.resolve());
  const failed = runWithAsyncWorkResources(async (onAcquired) => {
    onAcquired({ release: releaseAuthority });
    return await owner.withCodexAppServerThreadMutationHold("held-thread", async (hold) => {
      hold(release.promise);
      throw new Error("cleanup uncertain");
    });
  });
  const failure = expect(failed).rejects.toThrow("cleanup uncertain");

  const successorRun = vi.fn(async () => {});
  const successorMutation = successor.withCodexAppServerThreadMutation("held-thread", successorRun);
  try {
    await failure;
    await setImmediate();
    expect(successorRun).not.toHaveBeenCalled();
    expect(releaseAuthority).not.toHaveBeenCalled();
  } finally {
    release.resolve();
    await successorMutation;
    await authorityReleased.promise;
  }
  expect(releaseAuthority).toHaveBeenCalledOnce();
  expect(successorRun).toHaveBeenCalledOnce();
});
