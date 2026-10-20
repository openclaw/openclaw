import assert from "node:assert/strict";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { expect, it, onTestFinished, vi } from "vitest";
import { fixture } from "./native-subagent-inventory.test-support.js";
import {
  agentMessage,
  closeAgentNotification,
  createClient,
  threadRead,
} from "./native-subagent-monitor.test-support.js";
import { setupRunAttemptTestHooks } from "./run-attempt-test-harness.js";

setupRunAttemptTestHooks();

function observeAssignment(
  store: Awaited<ReturnType<typeof fixture>>["store"],
  nativeTurnId: string,
) {
  const recorded = createDeferred<void>();
  const consumed = createDeferred<void>();
  const mutate = store.mutate.bind(store);
  vi.spyOn(store, "mutate").mockImplementation(async (identity, mutation, assertCurrent) => {
    const result = mutate(identity, mutation, assertCurrent);
    if (mutation.kind === "consume-native-subagent-assignment") {
      consumed.resolve();
    }
    const applied = await result;
    if (
      applied &&
      mutation.kind === "record-native-subagent-assignment" &&
      mutation.assignment.nativeTurnId === nativeTurnId
    ) {
      recorded.resolve();
    }
    return applied;
  });
  return { recorded: recorded.promise, consumed: consumed.promise };
}

it("settles delayed close writes without consuming a replacement monitor's resumed assignment", async () => {
  const f = await fixture();
  const firstClient = createClient();
  const first = await f.register(firstClient);
  await first.ready;
  first.bindTurn("parent-turn");

  const initial = observeAssignment(f.store, "child-turn");
  await f.spawn(firstClient);
  await initial.recorded;
  await firstClient.completeTurn({ status: "interrupted" });

  const closeEntered = createDeferred<void>();
  const closeResponse = createDeferred<{ data: string[]; nextCursor: null }>();
  const request = firstClient.request.getMockImplementation();
  assert(request);
  firstClient.request.mockImplementation(async (method, ...args) => {
    if (method === "thread/loaded/list") {
      closeEntered.resolve();
      return await closeResponse.promise;
    }
    return await request(method, ...args);
  });
  await firstClient.notify(closeAgentNotification({ method: "item/started" }));
  const closing = firstClient.notify(closeAgentNotification({ method: "item/completed" }));
  await closeEntered.promise;

  const peer = f.newBindingStore();
  const leaseEntered = createDeferred<void>();
  const recover = createDeferred<void>();
  const releaseLease = createDeferred<void>();
  const successor = observeAssignment(peer, "resumed-turn");
  const nextClient = createClient();
  const history = threadRead({ turnId: "child-turn", status: "interrupted" });
  const continuation = threadRead({
    turnId: "resumed-turn",
    status: "inProgress",
    threadStatus: "active",
  });
  assert(history.thread.turns && continuation.thread.turns);
  history.thread.turns.push(...continuation.thread.turns);
  history.thread.status = { type: "active" };
  nextClient.setThreadRead("child-thread", history);
  const replacement = createDeferred<Awaited<ReturnType<typeof f.register>>>();
  let cleaningUp = false;
  const lease = peer.withLease(f.identity, async () => {
    leaseEntered.resolve();
    await recover.promise;
    if (cleaningUp) {
      return;
    }
    const next = await f.register(nextClient, f.historyOwner(), undefined, undefined, {
      bindingStore: peer,
    });
    await next.ready;
    replacement.resolve(next);
    await releaseLease.promise;
  });
  void lease.catch((error: unknown) => replacement.reject(error));
  onTestFinished(async () => {
    cleaningUp = true;
    closeResponse.resolve({ data: [], nextCursor: null });
    recover.resolve();
    releaseLease.resolve();
    await lease;
  });
  await leaseEntered.promise;

  let unregistered = false;
  const unregister = first.unregister().then(() => {
    unregistered = true;
  });
  // The initial drain finishes while native close confirmation is still pending.
  await vi.advanceTimersByTimeAsync(0);
  closeResponse.resolve({ data: [], nextCursor: null });
  await closing;
  await initial.consumed;
  firstClient.close();
  recover.resolve();
  const next = await replacement.promise;
  await successor.recorded;
  const earlyUnregister = unregistered;
  releaseLease.resolve();
  await lease;
  await vi.advanceTimersByTimeAsync(1_000);
  await unregister;
  first.closeCaller();

  expect
    .soft({
      earlyUnregister,
      assignments: await f.store.readNativeSubagentAssignments?.(f.identity, f.historyOwner()),
    })
    .toMatchObject({
      earlyUnregister: false,
      assignments: [{ runId: "codex-thread:child-thread", nativeTurnId: "resumed-turn" }],
    });
  await nextClient.completeTurn({
    turnId: "resumed-turn",
    status: "completed",
    items: [agentMessage("final", "Resumed result", "final_answer")],
  });
  await next.unregister();
  next.closeCaller();
  expect(f.deliver).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      childSessionKey: "codex-thread:child-thread",
      result: "Resumed result",
    }),
  );
  expect(await f.store.readNativeSubagentAssignments?.(f.identity, f.historyOwner())).toEqual([]);
  nextClient.close();
  const duplicate = await f.register(createClient());
  await duplicate.ready;
  await duplicate.unregister();
  expect(f.deliver).toHaveBeenCalledOnce();
});
