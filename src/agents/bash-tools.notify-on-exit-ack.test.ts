import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from "vitest";
import type { dispatchInboundMessageWithRoutedChannelDispatcher } from "../auto-reply/dispatch.js";
import { enqueueSessionEventForHost as enqueueSessionEvent } from "../auto-reply/reply/session-event-handoff.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { writeSessionEntry } from "../config/sessions/session-accessor.sqlite-entry-store.js";
import {
  consumeSelectedSystemEventEntries,
  enqueueSystemEventEntry,
  peekSystemEventEntries,
  resetSystemEventsForTest,
} from "../infra/system-events.js";
import * as gatewayWork from "../process/gateway-work-admission.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { startDeferredNotifyRun } from "./bash-tools.notify-on-exit-ack.test-support.js";
import { createProcessTool } from "./bash-tools.process.js";
import { acknowledgeInternalToolResult } from "./runtime/internal-hooks.js";

const supervisorSpawnMock = vi.hoisted(() => vi.fn());
const randomMock = vi.hoisted(() => vi.fn(() => 0));
vi.mock("../auto-reply/reply/session-event-handoff.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../auto-reply/reply/session-event-handoff.js")>();
  return { ...actual, enqueueSessionEventForHost: vi.fn(actual.enqueueSessionEventForHost) };
});
// mock-isolation: Force deferred dispatch to test occurrence acknowledgment without model turns.
vi.mock("../auto-reply/dispatch.js", () => ({
  dispatchInboundMessageWithRoutedChannelDispatcher: vi.fn<
    typeof dispatchInboundMessageWithRoutedChannelDispatcher
  >(async ({ replyOptions }) => {
    const lifecycle = expectDefined(replyOptions?.turnAdoptionLifecycle, "notification lifecycle");
    const signal = expectDefined(lifecycle.abortSignal, "notification cancellation");
    lifecycle.onDeferred?.();
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      try {
        lifecycle.onAbandoned?.();
      } finally {
        lifecycle.onSettled?.();
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
    }
    return {
      deferredToActiveRun: "followup",
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 0 },
    };
  }),
}));
vi.mock("../infra/secure-random.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/secure-random.js")>()),
  generateSecureInt: randomMock,
}));
vi.mock("../process/supervisor/index.js", () => ({
  getProcessSupervisor: () => ({ spawn: supervisorSpawnMock }),
}));

const QUEUE_KEY = "agent:main:notify-ack";
const startNotifyRun = () =>
  startDeferredNotifyRun({
    spawn: supervisorSpawnMock,
    sessionKey: QUEUE_KEY,
    notifyDeliveryContext: { channel: "telegram", to: "-100123", threadId: 42 },
  });
const processTool = createProcessTool();
const execute = (action: "poll" | "clear", sessionId: string) =>
  processTool.execute(`${action}-${sessionId}`, { action, sessionId });
const poll = (sessionId: string) => execute("poll", sessionId);
const contexts = () => peekSystemEventEntries(QUEUE_KEY).map((event) => event.contextKey);

async function finishNotifyRun(process: Awaited<ReturnType<typeof startDeferredNotifyRun>>) {
  await process.finish();
  const result = vi.mocked(enqueueSessionEvent).mock.results.at(-1);
  if (result?.type !== "return") {
    throw new Error("Expected an exec completion receipt");
  }
  await expect(result.value.accepted).resolves.toEqual({ ok: true });
  return result.value;
}

let state: OpenClawTestState;
let continuation: MockInstance<typeof gatewayWork.runWithGatewayDetachedWorkContinuation>;
beforeEach(async () => {
  continuation = vi.spyOn(gatewayWork, "runWithGatewayDetachedWorkContinuation");
  state = await createOpenClawTestState({ layout: "state-only", prefix: "exec-occurrence-" });
  setRuntimeConfigSnapshot({ agents: { entries: { main: {}, research: {} } } });
  openOpenClawStateDatabase({ env: state.env });
  for (const { agentId, sessionKey } of [
    { agentId: "main", sessionKey: QUEUE_KEY },
    { agentId: "research", sessionKey: "global" },
  ]) {
    writeSessionEntry(openOpenClawAgentDatabase({ agentId, env: state.env }), sessionKey, {
      sessionId: `${agentId}-origin`,
      lifecycleRevision: "original-revision",
      updatedAt: Date.now(),
    });
  }
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now);
});
afterEach(async () => {
  resetProcessRegistryForTests();
  resetSystemEventsForTest();
  await Promise.allSettled(
    continuation.mock.results.flatMap((result) => (result.type === "return" ? [result.value] : [])),
  );
  expect(gatewayWork.getActiveGatewayRootWorkCount()).toBe(0);
  vi.clearAllMocks();
  vi.restoreAllMocks();
  clearRuntimeConfigSnapshot();
  await state.cleanup();
});

it("keeps selected-agent global completions scoped to their owner", async () => {
  const process = await startDeferredNotifyRun({
    spawn: supervisorSpawnMock,
    sessionKey: "global",
    agentId: "research",
  });
  await finishNotifyRun(process);

  expect(enqueueSessionEvent).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({
      source: "exec",
      agentId: "research",
      sessionKey: "global",
      expectedTarget: expect.objectContaining({ agentId: "research" }),
    }),
  );
  expect(peekSystemEventEntries("agent:research:global")).toHaveLength(1);
  expect(peekSystemEventEntries("agent:main:global")).toEqual([]);
});

it("isolates identical completions across exact full-slug reuse", async () => {
  const first = await startNotifyRun();
  await finishNotifyRun(first);
  await execute("clear", first.run.session.id);
  enqueueSystemEventEntry("unrelated", { sessionKey: QUEUE_KEY, contextKey: "marker" });
  const second = await startNotifyRun();
  await finishNotifyRun(second);

  expect([first.run.session.id, second.run.session.id]).toEqual(["amber-atlas", "amber-atlas"]);
  expect(contexts()).toEqual(["exec:amber-atlas", "marker", "exec:amber-atlas"]);
  const queued = peekSystemEventEntries(QUEUE_KEY);
  expect(queued[0]?.id).not.toBe(queued[2]?.id);
  expect(queued[0]).toEqual({ ...queued[2], id: queued[0]?.id });

  const result = await poll(second.run.session.id);
  expect(peekSystemEventEntries(QUEUE_KEY)).toEqual(queued);
  acknowledgeInternalToolResult(result);
  expect(contexts()).toEqual(["exec:amber-atlas", "marker"]);
  acknowledgeInternalToolResult(await poll(second.run.session.id));
  expect(contexts()).toEqual(["exec:amber-atlas", "marker"]);
});

it("keeps an identical successor queued when an earlier consumer settles", async () => {
  const first = await startNotifyRun();
  const receipt = await finishNotifyRun(first);
  const snapshot = peekSystemEventEntries(QUEUE_KEY);
  const result = await poll(first.run.session.id);
  expect(peekSystemEventEntries(QUEUE_KEY)).toEqual(snapshot);
  acknowledgeInternalToolResult(result);
  await execute("clear", first.run.session.id);
  const successor = await startNotifyRun();
  await finishNotifyRun(successor);
  expect(successor.run.session.id).toBe(first.run.session.id);
  await expect(receipt.settled).resolves.toMatchObject({
    status: "cancelled",
    executionStarted: false,
  });
  expect(consumeSelectedSystemEventEntries(QUEUE_KEY, snapshot)).toEqual([]);
  const queued = peekSystemEventEntries(QUEUE_KEY);
  expect(queued).toHaveLength(1);
  expect(queued[0]?.id).not.toBe(snapshot[0]?.id);
  const successorResult = await poll(successor.run.session.id);
  expect(peekSystemEventEntries(QUEUE_KEY)).toEqual(queued);
  acknowledgeInternalToolResult(successorResult);
  expect(peekSystemEventEntries(QUEUE_KEY)).toEqual([]);
});
