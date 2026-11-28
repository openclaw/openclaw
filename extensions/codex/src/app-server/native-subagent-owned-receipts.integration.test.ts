import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { expect, it, onTestFinished, vi } from "vitest";
import { ensureCodexAppServerClientRuntime } from "./client-runtime.js";
import {
  CodexNativeSubagentMonitor,
  createClient,
  createRuntime,
  parentRegistration,
  nativeHistoryOwner,
  notifyChildStarted,
  childTurnCompletedNotification,
  threadRead,
  observeCompletionAttempts,
} from "./native-subagent-monitor.test-support.js";
import {
  ownedReceiptFixture,
  metadata,
  context,
  intent,
  childTurn,
} from "./native-subagent-owned-receipts.test-support.js";
import { createNativeSubagentRegistrationGuards } from "./native-subagent-receipt-retirement.js";

async function fixture(
  options: {
    records?: Parameters<typeof ownedReceiptFixture>[0];
    duplicateResult?: boolean;
    assertCurrent?: () => Promise<void>;
    sourceCurrent?: () => void;
    remote?: boolean;
    yielded?: boolean;
    parentStatus?: "completed" | "failed" | "interrupted";
    bindAfterCompletion?: boolean;
  } = {},
) {
  const f = await ownedReceiptFixture(options.records);
  const client = createClient();
  vi.spyOn(client.client, "getRuntimeIdentity").mockReturnValue({
    serverVersion: "test",
    codexHome: f.home,
  });
  vi.spyOn(client.client, "getTransportPid").mockReturnValue(
    options.remote ? undefined : process.pid,
  );
  ensureCodexAppServerClientRuntime(client.client, { agentDir: f.home });
  const runtime = createRuntime();
  const monitor = new CodexNativeSubagentMonitor(client.client, runtime);
  const attempts = observeCompletionAttempts();
  const source = {
    sourceIdentity: {},
    assertCurrent: options.sourceCurrent ?? (() => {}),
    release: vi.fn(),
  };
  const parent = await monitor.registerParent({
    ...parentRegistration(),
    historyOwner: nativeHistoryOwner(),
    modelSource: source,
    assertReceiptObservationCurrent: options.assertCurrent ?? (async () => {}),
    isTurnYielded: () => options.yielded === true,
  });
  onTestFinished(async () => {
    await parent.unregister();
    await monitor.dispose();
    client.close();
    vi.restoreAllMocks();
  });
  if (!options.bindAfterCompletion) {
    parent.bindTurn("parent-turn");
  }
  await notifyChildStarted(client, "parent-thread", "child-thread", "/root/worker");
  await client.notify(
    childTurnCompletedNotification({
      status: "completed",
      items: [{ type: "agentMessage", id: "final", phase: "final_answer", text: "Child result" }],
    }),
  );
  const parentRead = threadRead({ childThreadId: "parent-thread" });
  parentRead.thread.path = f.params.rolloutPath;
  client.setThreadRead("parent-thread", parentRead);
  client.setThreadRead(
    "child-thread",
    threadRead({ turnId: "child-turn", result: "Child result", agentPath: "/root/worker" }),
  );
  client.setThreadTurns("child-thread", {
    data: [...(options.duplicateResult ? [childTurn("earlier")] : []), childTurn()],
    nextCursor: null,
  });
  await client.notify(
    childTurnCompletedNotification({
      threadId: "parent-thread",
      turnId: "parent-turn",
      status: options.parentStatus ?? "completed",
    }),
  );
  if (options.bindAfterCompletion) {
    parent.bindTurn("parent-turn");
  }
  return { ...f, client, runtime, monitor, parent, attempts, source };
}

it("does not redeliver consumed native input when cold resume omitted raw receipt notifications", async () => {
  const f = await fixture();
  await f.parent.unregister();
  await f.attempts.settle();
  expect(f.runtime.deliverAgentHarnessCompletion).not.toHaveBeenCalled();
  expect(f.source.release).toHaveBeenCalledOnce();
});

it.each([
  { parentStatus: "failed", bindAfterCompletion: false },
  { parentStatus: "interrupted", bindAfterCompletion: false },
  { parentStatus: "failed", bindAfterCompletion: true },
  { parentStatus: "interrupted", bindAfterCompletion: true },
] as const)(
  "retains fallback when parent $parentStatus, bind after completion: $bindAfterCompletion",
  async ({ parentStatus, bindAfterCompletion }) => {
    const f = await fixture({ parentStatus, bindAfterCompletion });
    await f.parent.unregister();
    await f.attempts.settle();
    expect(f.runtime.deliverAgentHarnessCompletion).toHaveBeenCalledOnce();
  },
);

it("observes a successful parent completion that arrived before binding", async () => {
  const f = await fixture({ bindAfterCompletion: true });
  await f.parent.unregister();
  await f.attempts.settle();
  expect(f.runtime.deliverAgentHarnessCompletion).not.toHaveBeenCalled();
});

it.each([
  { name: "typed intent without consumption", records: [metadata(), context(), intent()] },
  { name: "same output in another child turn", duplicateResult: true },
  { name: "remote transport", remote: true },
  { name: "yielded parent", yielded: true },
  {
    name: "revoked lifecycle",
    assertCurrent: async () => {
      throw new Error("revoked");
    },
  },
])("preserves fallback for unproved consumption: $name", async (options) => {
  const f = await fixture(options);
  await f.parent.unregister();
  await f.attempts.settle();
  expect(f.runtime.deliverAgentHarnessCompletion).toHaveBeenCalledOnce();
});

it("bounds the complete lifecycle observation to thirty seconds and ignores its late resolution", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  onTestFinished(() => {
    vi.useRealTimers();
  });
  const blocked = createDeferred<void>();
  let validated = false;
  const f = await fixture({
    assertCurrent: async () => {
      await blocked.promise;
      validated = true;
    },
  });
  const settlement = f.parent.unregister();
  try {
    await vi.advanceTimersByTimeAsync(29_000);
    expect(f.runtime.deliverAgentHarnessCompletion).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    await settlement;
    await f.attempts.settle();
    expect(f.runtime.deliverAgentHarnessCompletion).toHaveBeenCalledOnce();
    blocked.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(validated).toBe(true);
    expect(f.runtime.deliverAgentHarnessCompletion).toHaveBeenCalledOnce();
  } finally {
    blocked.resolve();
    await settlement;
  }
});

it("rejects source custody revoked during asynchronous lifecycle validation", async () => {
  let current = true;
  const f = await fixture({
    sourceCurrent: () => {
      if (!current) {
        throw new Error("revoked source");
      }
    },
    assertCurrent: async () => {
      current = false;
    },
  });
  await f.parent.unregister();
  await f.attempts.settle();
  expect(f.runtime.deliverAgentHarnessCompletion).toHaveBeenCalledOnce();
});

it("permits observation after execution closes without retaining execution or a stale connection", async () => {
  let executionOpen = true;
  let connectionOpen = true;
  const guards = createNativeSubagentRegistrationGuards({
    signal: new AbortController().signal,
    hostCapabilities: {
      assertActive: () => {
        if (!executionOpen) {
          throw new Error("execution closed");
        }
      },
    },
    connection: {
      assertCurrent: () => {
        if (!connectionOpen) {
          throw new Error("connection revoked");
        }
      },
    },
    parent: { assertCurrent: async () => {} },
    submissionStore: undefined,
    thread: {},
  });
  guards.assertCurrent();
  executionOpen = false;
  expect(guards.assertCurrent).toThrow("execution closed");
  await expect(guards.assertReceiptObservationCurrent?.()).resolves.toBeUndefined();
  connectionOpen = false;
  await expect(guards.assertReceiptObservationCurrent?.()).rejects.toThrow("connection revoked");
});
