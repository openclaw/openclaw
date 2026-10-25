import assert from "node:assert/strict";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { expect, it, onTestFinished, vi } from "vitest";
import { fixture } from "./native-subagent-inventory.test-support.js";
import { codexNativeSubagentMonitorRuntime } from "./native-subagent-monitor.js";
import {
  agentMessage,
  childTurnCompletedNotification,
  closeAgentNotification,
  createClient,
  directSpawnItem,
  itemNotification,
  turnStartedNotification,
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
      assignments: await f.assignments(),
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
  expect(await f.assignments()).toEqual([]);
  nextClient.close();
  await f.settle(createClient());
  expect(f.deliver).toHaveBeenCalledOnce();
});

it("reads direct and nested native observations only for the registered physical requester", async () => {
  const f = await fixture();
  const client = createClient();
  const parent = await f.register(client);
  await parent.ready;
  parent.bindTurn("parent-turn");
  const request = {
    client: client.client,
    agentId: f.identity.agentId,
    sessionKey: f.identity.sessionKey,
    sessionId: f.identity.sessionId,
    lifecycleRevision: f.historyOwner().lifecycleRevision,
    storePath: resolveStorePath(undefined, { agentId: f.identity.agentId }),
    parentThreadId: "parent-thread",
    historyOwner: f.historyOwner(),
    assertCurrent: vi.fn(),
  };
  const read = () => codexNativeSubagentMonitorRuntime.readNativeSubagents(request);
  expect(read()).toEqual({ coverage: "live", children: [], truncated: false });
  await client.notify(itemNotification(directSpawnItem("v2", "parent-thread", "child-thread")));
  await client.notify(turnStartedNotification("child-turn"));
  await client.notify(
    itemNotification(
      directSpawnItem("v2", "child-thread", "nested-thread"),
      "child-turn",
      "child-thread",
    ),
  );
  await client.notify(turnStartedNotification("nested-turn", { threadId: "nested-thread" }));
  expect(read()).toEqual({
    coverage: "live",
    children: [
      { id: "child-thread", label: "/root/child-thread", status: "running" },
      { id: "nested-thread", label: "/root/nested-thread", status: "running" },
    ],
    truncated: false,
  });
  for (const changed of [
    { sessionId: "foreign-physical-session" },
    { lifecycleRevision: "foreign-lifecycle" },
    { storePath: `${request.storePath}.foreign` },
    { sessionKey: "agent:main:foreign" },
    { agentId: "foreign" },
    { historyOwner: { ...request.historyOwner, connectionFingerprint: "f".repeat(64) } },
  ]) {
    expect(
      codexNativeSubagentMonitorRuntime.readNativeSubagents({ ...request, ...changed }),
    ).toBeUndefined();
  }
  await client.notify(childTurnCompletedNotification({ status: "completed" }));
  await client.notify(
    childTurnCompletedNotification({
      status: "interrupted",
      threadId: "nested-thread",
      turnId: "nested-turn",
    }),
  );
  expect(read()?.children).toEqual([
    { id: "child-thread", label: "/root/child-thread", status: "completed" },
    { id: "nested-thread", label: "/root/nested-thread", status: "interrupted" },
  ]);
  // Turn completion is observation, not a fabricated result or consumed delivery receipt.
  expect(f.deliver).not.toHaveBeenCalled();
  request.assertCurrent.mockImplementation(() => {
    throw new Error("Synthetic read scope revoked");
  });
  expect(read).toThrow("Synthetic read scope revoked");
  request.assertCurrent.mockReset();
  client.close();
  expect(read()).toBeUndefined();
});

it("does not create an observation owner after an idle parent is pruned", async () => {
  const f = await fixture();
  const client = createClient();
  const parent = await f.register(client);
  await parent.ready;
  const request = {
    client: client.client,
    agentId: f.identity.agentId,
    sessionKey: f.identity.sessionKey,
    sessionId: f.identity.sessionId,
    lifecycleRevision: f.historyOwner().lifecycleRevision,
    storePath: resolveStorePath(undefined, { agentId: f.identity.agentId }),
    parentThreadId: "parent-thread",
    historyOwner: f.historyOwner(),
    assertCurrent() {},
  };
  expect(codexNativeSubagentMonitorRuntime.readNativeSubagents(request)?.coverage).toBe("live");
  await parent.unregister();
  expect(codexNativeSubagentMonitorRuntime.readNativeSubagents(request)).toBeUndefined();
  client.close();
});
