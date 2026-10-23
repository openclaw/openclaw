import { setImmediate } from "node:timers/promises";
import { expect, it } from "vitest";
import {
  ensureCodexAppServerClientRuntime,
  retainCodexAppServerLiveThread,
} from "./client-runtime.js";
import {
  getSharedCodexAppServerClientState,
  retainSharedClientEntry,
  retireSharedCodexAppServerClientIfCurrent,
  type SharedCodexAppServerClientEntry,
} from "./shared-client-lifecycle.js";
import { createClientHarness } from "./test-support.js";
import { createCodexThreadLifecycleTimingTracker } from "./thread-lifecycle-timing.js";
import { releaseCodexBoundLiveThread } from "./thread-lifecycle-warm.js";

function createFixture(label: string) {
  const old = createClientHarness({ autoEmitExit: false });
  const successor = createClientHarness();
  const state = getSharedCodexAppServerClientState();
  const key = `handoff-closure:${label}`;
  const entry: SharedCodexAppServerClientEntry = {
    key,
    client: old.client,
    activeLeases: 0,
    anonymousLeases: 0,
    pendingAcquires: 0,
    closeWhenIdle: false,
    onStartedClientCallbacks: new Set(),
  };
  state.clients.set(key, entry);
  state.liveClients.add(old.client);
  state.entriesByClient.set(old.client, entry);
  const releaseSiblingLease = retainSharedClientEntry(entry);
  const threadId = `${key}:thread`;
  ensureCodexAppServerClientRuntime(old.client, { agentDir: "" });

  const cleanup = () => {
    releaseSiblingLease();
    old.client.close();
    old.emitExit();
    successor.client.close();
    successor.emitExit();
    state.liveClients.delete(old.client);
    state.entriesByClient.delete(old.client);
    if (state.clients.get(key) === entry) {
      state.clients.delete(key);
    }
  };
  return { old, successor, entry, threadId, cleanup };
}

it("releases a retired handoff after the exact thread closes while a sibling lease stays live", async () => {
  const fixture = createFixture("observed-after-listener");
  await retainCodexAppServerLiveThread(fixture.old.client, fixture.threadId, async () => undefined);
  retireSharedCodexAppServerClientIfCurrent(fixture.old.client);
  let settled = false;
  const handoff = releaseCodexBoundLiveThread({
    client: fixture.successor.client,
    clientId: fixture.successor.client.getInstanceId(),
    ownerClientId: fixture.old.client.getInstanceId(),
    threadId: fixture.threadId,
    lifecycleTiming: createCodexThreadLifecycleTimingTracker(),
  }).then(() => {
    settled = true;
  });

  try {
    await setImmediate();
    expect(settled).toBe(false);
    fixture.old.send({ method: "thread/closed", params: { threadId: "unrelated" } });
    await setImmediate();
    expect(settled).toBe(false);
    fixture.old.send({ method: "thread/closed", params: { threadId: fixture.threadId } });
    await handoff;
    expect(settled).toBe(true);
    expect(fixture.entry.activeLeases).toBe(1);
    expect(fixture.old.process.exitCode).toBeNull();
  } finally {
    fixture.old.emitExit();
    await Promise.allSettled([handoff]);
    fixture.cleanup();
  }
});

it("releases a retired handoff when exact closure preceded listener registration", async () => {
  const fixture = createFixture("observed-before-listener");
  await retainCodexAppServerLiveThread(fixture.old.client, fixture.threadId, async () => undefined);
  retireSharedCodexAppServerClientIfCurrent(fixture.old.client);
  fixture.old.send({ method: "thread/closed", params: { threadId: fixture.threadId } });

  try {
    await expect(
      releaseCodexBoundLiveThread({
        client: fixture.successor.client,
        clientId: fixture.successor.client.getInstanceId(),
        ownerClientId: fixture.old.client.getInstanceId(),
        threadId: fixture.threadId,
        lifecycleTiming: createCodexThreadLifecycleTimingTracker(),
      }),
    ).resolves.toBe(false);
    expect(fixture.entry.activeLeases).toBe(1);
    expect(fixture.old.process.exitCode).toBeNull();
  } finally {
    fixture.cleanup();
  }
});
