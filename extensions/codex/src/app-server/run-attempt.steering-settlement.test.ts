import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { resolveActiveEmbeddedRunSessionId } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  createPluginRecord,
  createPluginRegistry,
  createPluginRuntimeMock,
  disposePluginRegistryInstances,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  appendSessionTranscriptMessageByIdentity,
  withSessionTranscriptWriteLock,
} from "openclaw/plugin-sdk/session-transcript-runtime";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createCodexAppServerAgentHarness } from "../../harness.js";
import type { CodexSteeringQueueOptions } from "./attempt-steering.js";
import { readAttemptTerminal } from "./attempt-terminal.test-helper.js";
import { TURN_TERMINAL_SETTLEMENT_TIMEOUT_MS } from "./attempt-timeouts.js";
import { nativeCommandItem } from "./codex-app-server.test-fixtures.js";
import { prepareCodexServerNotification } from "./protocol-validators.js";
import { isJsonObject, type CodexServerNotification, type JsonObject } from "./protocol.js";
import { itemNotification, turnCompleted } from "./protocol.test-helpers.js";
import {
  bindProductionHarnessHostCapabilitiesForTest,
  createStartedThreadHarness,
  createTestParams,
  fastWait,
  queueActiveRunMessageForTest,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  tempDir,
} from "./run-attempt-test-harness.js";
import { createSteeringRecorder } from "./run-attempt.steering.test-support.js";
import { testCodexAppServerBindingStore } from "./session-binding.test-helpers.js";
import {
  attachSqliteSessionTarget,
  readTranscriptMessagesByIdentity,
} from "./sqlite-session.test-helpers.js";
import { codexTranscriptMirrorRuntime } from "./transcript-mirror.js";

setupRunAttemptTestHooks();

const prefixText = "Earlier completed answer.";
const steerText = "Use this committed follow-up.";
const codaText = "Completed the steered request.";
const prefix = { id: "prefix", type: "agentMessage", phase: "final_answer", text: prefixText };
const successfulTerminal = { aborted: false, timedOut: false, promptError: null };

async function createFixture() {
  const params = createTestParams();
  await attachSqliteSessionTarget(
    params,
    path.join(tempDir, "steering-settlement.sqlite"),
    "steering-settlement",
  );
  const target = {
    ...params.sessionTarget,
    agentId: "main",
    sessionId: params.sessionId,
    sessionKey: expectDefined(params.sessionKey, "steering session key"),
  };
  params.timeoutMs = 60 * 60_000;
  const closeHost = await bindProductionHarnessHostCapabilitiesForTest(params);
  const message = {
    role: "user" as const,
    content: steerText,
    timestamp: 1,
    idempotencyKey: "steer-source:user",
  };
  let persisted = false;
  const recorder = createSteeringRecorder(
    message,
    async () => {
      if (!persisted) {
        const committed = await appendSessionTranscriptMessageByIdentity({ ...target, message });
        persisted = Boolean(committed);
      }
      return undefined;
    },
    () => persisted,
  );
  const started = createDeferred<void>();
  const prefixCompleted = createDeferred<void>();
  const abort = new AbortController();
  const onAttemptTimeout = vi.fn();
  params.abortSignal = abort.signal;
  params.onAttemptTimeout = onAttemptTimeout;
  params.onAgentEvent = (event) => {
    if (event.stream === "lifecycle" && event.data.phase === "start") {
      started.resolve();
    }
    if (
      event.stream === "codex_app_server.item" &&
      event.data.phase === "completed" &&
      event.data.itemId === prefix.id
    ) {
      prefixCompleted.resolve();
    }
  };
  const registration = createPluginRegistry({
    runtime: createPluginRuntimeMock({ config: { current: () => params.config ?? {} } }),
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    activateGlobalSideEffects: false,
  });
  const record = createPluginRecord({
    id: "codex",
    origin: "bundled",
    source: path.join(tempDir, "bundled-codex", "index.js"),
    rootDir: path.join(tempDir, "bundled-codex"),
  });
  registration.registry.plugins.push(record);
  registration
    .createApi(record, { config: params.config ?? {} })
    .registerAgentHarness(
      createCodexAppServerAgentHarness({ bindingStore: testCodexAppServerBindingStore }),
    );
  setActivePluginRegistry(registration.registry);
  const registeredHarness = expectDefined(
    registration.registry.agentHarnesses[0]?.harness,
    "registrar-owned bundled Codex harness",
  );
  const harness = createStartedThreadHarness();
  const run = runCodexAppServerAttempt(params, { registeredHarness });
  const accepted = vi.fn();
  let lock: ReturnType<typeof holdTranscript> | undefined;
  const notifications: Promise<unknown>[] = [];
  const notify = (notification: CodexServerNotification) => {
    const pending = harness.notify(notification);
    notifications.push(pending);
    return pending;
  };
  return {
    params,
    target,
    recorder,
    onAttemptTimeout,
    harness,
    run,
    accepted,
    start: async () => {
      await started.promise;
      await notify(itemNotification("item/started", { ...prefix, text: "" }));
      await notify({
        method: "item/agentMessage/delta",
        params: { threadId: "thread-1", turnId: "turn-1", itemId: prefix.id, delta: prefixText },
      });
      await notify(itemNotification("item/completed", prefix));
      // Wait for projection, not merely a buffered wire receipt, before steering.
      await prefixCompleted.promise;
    },
    item: (item: JsonObject) => notify(itemNotification("item/completed", item)),
    complete: (items: JsonObject[]) => {
      const notification = turnCompleted({ id: "turn-1", status: "completed", items });
      expect(prepareCodexServerNotification(notification).completedTurn).toBeDefined();
      return notify(notification);
    },
    hold: async () => {
      lock = holdTranscript(target);
      await lock.acquired;
      return lock;
    },
    cleanup: async () => {
      lock?.release();
      abort.abort("test cleanup");
      vi.useRealTimers();
      try {
        await Promise.allSettled([run, ...notifications, ...(lock ? [lock.writer] : [])]);
      } finally {
        closeHost();
        await disposePluginRegistryInstances(registration.registry);
      }
    },
    readMessages: () => readTranscriptMessagesByIdentity(params),
    queue: (options: Partial<CodexSteeringQueueOptions> = {}) =>
      queueActiveRunMessageForTest(params.sessionId, steerText, {
        debounceMs: 0,
        isInboundUserMessage: true,
        toolAuthorityFingerprint: params.toolAuthorityFingerprint,
        userTurnTranscriptRecorder: recorder,
        waitForTranscriptCommit: true,
        onQueueAccepted: accepted,
        ...options,
      }),
  };
}

let f: Awaited<ReturnType<typeof createFixture>>;
let cleanup = async () => {};
beforeEach(async () => {
  cleanup = async () => {};
  f = await createFixture();
  cleanup = f.cleanup;
  await f.start();
});
afterEach(async () => {
  await cleanup();
});

function holdTranscript(target: Parameters<typeof withSessionTranscriptWriteLock>[0]) {
  const acquired = createDeferred<void>();
  const release = createDeferred<void>();
  const writer = withSessionTranscriptWriteLock(target, async () => {
    acquired.resolve();
    await release.promise;
  });
  return { acquired: acquired.promise, release: release.resolve, writer };
}

function messageText({ content }: Record<string, unknown>): string {
  return typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .flatMap((block) =>
            isJsonObject(block) && block.type === "text" && typeof block.text === "string"
              ? [block.text]
              : [],
          )
          .join("")
      : "";
}

it("seals native steering when terminal receipt arrives behind its queued prefix write", async () => {
  const lock = await f.hold();
  const mirror = vi.spyOn(codexTranscriptMirrorRuntime, "mirror");
  expect(f.queue()).toBe(true);
  await vi.waitFor(() => expect(mirror).toHaveBeenCalledOnce(), fastWait);
  expect(f.recorder.persistApproved).not.toHaveBeenCalled();
  expect(f.harness.requests.some((request) => request.method === "turn/steer")).toBe(false);

  const terminal = f.complete([prefix]);
  await vi.waitFor(() => expect(f.accepted).toHaveBeenCalledExactlyOnceWith(false), fastWait);
  lock.release();
  await lock.writer;
  await terminal;
  const result = await f.run;

  expect(f.harness.requests.some((request) => request.method === "turn/steer")).toBe(false);
  expect(f.recorder.persistApproved).not.toHaveBeenCalled();
  expect(readAttemptTerminal(result)).toMatchObject(successfulTerminal);
  const messages = await f.readMessages();
  expect(messages.filter((message) => messageText(message) === steerText)).toEqual([]);
  expect(messages.filter((message) => messageText(message) === prefixText)).toHaveLength(1);
});

it("keeps one steering prefix and source through degraded tainted native completion", async () => {
  expect(f.queue()).toBe(true);
  await vi.waitFor(() => expect(f.accepted).toHaveBeenCalledExactlyOnceWith(true), fastWait);
  const steer = expectDefined(
    f.harness.requests.find((request) => request.method === "turn/steer"),
    "native steer",
  );
  expect(f.recorder.persistApproved).toHaveBeenCalledOnce();
  expect(steer.params).toMatchObject({
    input: [{ type: "text", text: steerText, text_elements: [] }],
  });
  const native = expectDefined(
    isJsonObject(steer.params) ? steer.params : undefined,
    "native steer parameters",
  );
  const clientId = expectDefined(
    typeof native.clientUserMessageId === "string" ? native.clientUserMessageId : undefined,
    "native steer correlation",
  );
  await f.item({
    id: "steered-user",
    type: "userMessage",
    clientId,
  });
  const before = (await f.readMessages()).map(messageText);
  expect(before.filter((text) => text === prefixText || text === steerText)).toEqual([
    prefixText,
    steerText,
  ]);

  const lock = await f.hold();
  const mirror = vi.spyOn(codexTranscriptMirrorRuntime, "mirror");
  vi.useFakeTimers();
  void f.item({
    ...nativeCommandItem("checkpoint-command", "completed", 1),
    command: "echo saved",
    cwd: f.params.workspaceDir,
    aggregatedOutput: "saved",
  });
  await vi.waitFor(() => expect(mirror).toHaveBeenCalledOnce(), fastWait);
  void f.item({
    id: "queued-search",
    type: "webSearch",
    query: "synthetic result",
    action: { type: "search", query: "synthetic result" },
    results: null,
  });
  const receivedAt = Date.now();
  void f.complete([
    prefix,
    { id: "coda", type: "agentMessage", phase: "final_answer", text: codaText },
  ]);
  await vi.advanceTimersByTimeAsync(receivedAt + TURN_TERMINAL_SETTLEMENT_TIMEOUT_MS - Date.now());
  await vi.advanceTimersByTimeAsync(1);
  lock.release();
  await lock.writer;
  // Keep the deadline clock fixed while the accepted SQLite work settles.
  const result = await f.run;
  vi.useRealTimers();

  expect(result).toMatchObject({
    lastAssistant: { stopReason: "stop" },
    terminal: {
      kind: "ok",
      settlementWarning: {
        pendingStage: "transcript/checkpoint",
        timeoutMs: TURN_TERMINAL_SETTLEMENT_TIMEOUT_MS,
      },
    },
  });
  expect(result.codexAppServerFailure).toBeUndefined();
  expect(readAttemptTerminal(result)).toMatchObject(successfulTerminal);
  expect(f.onAttemptTimeout).not.toHaveBeenCalled();
  expect(f.recorder.persistApproved).toHaveBeenCalledOnce();
  expect(f.harness.requests.filter((request) => request.method === "turn/steer")).toHaveLength(1);
  const messages = await f.readMessages();
  expect(
    messages.map(messageText).filter((text) => [prefixText, steerText, codaText].includes(text)),
  ).toEqual([prefixText, steerText, codaText]);
  expect(messages.find((message) => messageText(message) === codaText)).toMatchObject({
    stopReason: "stop",
    __openclaw: { turnTainted: true, settlementWarning: expect.any(Object) },
  });
  expect(resolveActiveEmbeddedRunSessionId(f.target.sessionKey)).toBeUndefined();
});

it("persists a controller-adapted human steer before native dispatch", async () => {
  const release = createDeferred<void>();
  const persist = expectDefined(
    f.recorder.persistApproved.getMockImplementation(),
    "recorder persistence",
  );
  f.recorder.persistApproved.mockImplementation(async () => {
    await release.promise;
    return await persist();
  });
  try {
    expect(
      f.queue({
        isInboundUserMessage: true,
        allowPendingUserInputAnswer: false,
      }),
    ).toBe(true);
    await vi.waitFor(() => expect(f.recorder.persistApproved).toHaveBeenCalledOnce(), fastWait);
    expect(f.harness.requests.filter((request) => request.method === "turn/steer")).toHaveLength(0);
    expect(f.accepted).not.toHaveBeenCalled();
    release.resolve();
    await vi.waitFor(() => expect(f.accepted).toHaveBeenCalledExactlyOnceWith(true), fastWait);
    expect(f.harness.requests.filter((request) => request.method === "turn/steer")).toHaveLength(1);
    expect(f.recorder.hasPersisted()).toBe(true);
    const steer = expectDefined(
      f.harness.requests.find((request) => request.method === "turn/steer"),
      "native steer",
    );
    const clientId = expectDefined(
      isJsonObject(steer.params) && typeof steer.params.clientUserMessageId === "string"
        ? steer.params.clientUserMessageId
        : undefined,
      "native steer correlation",
    );
    const userItem = {
      id: "adapted-human",
      type: "userMessage",
      clientId,
      content: [{ type: "text", text: steerText, text_elements: [] }],
    };
    await f.item(userItem);
    expect(f.recorder.persistApproved).toHaveBeenCalledOnce();
    expect(
      (await f.readMessages()).filter((message) => messageText(message) === steerText),
    ).toHaveLength(1);
    const finalItem = f.item({
      id: "adapted-human-final",
      type: "agentMessage",
      phase: "final_answer",
      text: codaText,
    });
    await f.complete([
      prefix,
      userItem,
      { id: "adapted-human-final", type: "agentMessage", phase: "final_answer", text: codaText },
    ]);
    await finalItem;
    expect(readAttemptTerminal(await f.run)).toMatchObject(successfulTerminal);
    expect(f.recorder.persistApproved).toHaveBeenCalledOnce();
    expect(
      (await f.readMessages()).filter((message) => messageText(message) === steerText),
    ).toHaveLength(1);
  } finally {
    release.resolve();
  }
});
