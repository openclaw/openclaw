import assert from "node:assert/strict";
import { afterEach, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot, clearRuntimeConfigSnapshot } from "../../../config/io.js";
import { resolveSessionStorePathCore } from "../../../config/sessions/paths.js";
import {
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../../../config/sessions/session-accessor.js";
import { publishSystemEventStoreResolver } from "../../../infra/system-event-ownership.js";
import type { ReplyBackendMessageInjectionV2 } from "../../../sessions/session-controller.contracts.js";
import { captureSessionTarget } from "../../../sessions/session-controller.lifecycle.js";
import { createReplyOperation } from "../../../sessions/session-controller.operation.js";
import {
  cleanupSessionStateTestState,
  createDatabaseOptions,
} from "../../../sessions/session-state-events.test-support.js";
import { RUNTIME_EVENT_USER_PROMPT } from "../../internal-runtime-context.js";
import { testing } from "../announce/subagent-announce-delivery.test-support.js";
import type { SubagentAnnounceDeliveryResult } from "../announce/subagent-announce-dispatch.js";
import { runSubagentAnnounceFlow } from "../announce/subagent-announce.js";
import { createLifecycleControllerFixture } from "./subagent-registry-lifecycle-controller.test-support.js";
import { mutateSubagentRuns } from "./subagent-registry-persistence.js";
import {
  createSubagentStoreRunFixture,
  loadSubagentRegistryFromSqlite,
} from "./subagent-registry-state.fixture.test-support.js";
import { observeRootWork } from "./subagent-registry.browser-cleanup.test-support.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

// The backend is the external model boundary. Controller admission, transcript
// persistence, announce classification, lifecycle receipts and SQLite are real.
afterEach(async () => {
  testing.setDepsForTest();
  publishSystemEventStoreResolver(undefined);
  clearRuntimeConfigSnapshot();
  await cleanupSessionStateTestState();
  vi.restoreAllMocks();
});

it("retains a completion accepted by a busy parent when source effects change before its steer receipt", async () => {
  createDatabaseOptions();
  setRuntimeConfigSnapshot({});
  const requesterSessionKey = "agent:main:main";
  const sessionId = "steer-owner-change-parent";
  const storePath = resolveSessionStorePathCore(undefined, { agentId: "main" });
  publishSystemEventStoreResolver(() => storePath);
  const requesterTarget = {
    agentId: "main",
    sessionKey: requesterSessionKey,
    sessionId,
    storePath,
  };
  await upsertSessionEntryCore(requesterTarget, {
    sessionId,
    lifecycleRevision: "parent-revision",
    updatedAt: Date.now(),
  });
  const resultText = "The accepted child's unique finished result: quartz-741.";
  const now = Date.now();
  const entry = createSubagentStoreRunFixture({
    runId: "steer-owner-change-child",
    requesterAgentId: "main",
    requesterSessionKey,
    requesterStorePath: storePath,
    createdAt: now - 10,
    execution: {
      status: "terminal",
      startedAt: now - 9,
      endedAt: now - 1,
      outcome: { status: "ok" },
      suppressSessionEffects: true,
    },
    completion: {
      required: true,
      resultText,
      capturedAt: now,
      terminalReply: { disposition: "visible", text: resultText },
    },
    delivery: { status: "pending", createdAt: now },
  });
  const runs = new Map<string, SubagentRunRecord>();
  await mutateSubagentRuns(
    [entry.runId],
    () => ({ value: undefined, postimages: new Map([[entry.runId, entry]]) }),
    { runs },
  );
  const target = captureSessionTarget({
    storeScope: storePath,
    sessionKey: requesterSessionKey,
    agentId: "main",
    incarnation: sessionId,
  });
  const operation = createReplyOperation({
    sessionKey: requesterSessionKey,
    sessionId,
    resetTriggered: false,
    target,
  });
  operation.setPhase("running");
  let effectsAllowed = true;
  const parentInbox: string[] = [];
  const queueMessage = vi.fn<ReplyBackendMessageInjectionV2["queueMessage"]>(
    async (_text, options, assertCurrent) => {
      assertCurrent();
      const recorder = options?.userTurnTranscriptRecorder;
      assert(recorder, "The real completion owner must supply its requester transcript recorder");
      const persisted = await recorder.persistApproved();
      assert(persisted, "Accepted completion must actually reach the requester transcript");
      parentInbox.push(options?.currentInboundContext?.text ?? _text);
      options?.onQueueAccepted?.(true);
      // Model acceptance has already committed; this is not a user stop or cancel.
      effectsAllowed = false;
    },
  );
  operation.attachBackend({
    kind: "embedded",
    cancel() {},
    supportsTranscriptCommitWait: true,
    messageInjectionV2: { version: 2, isAvailable: () => true, queueMessage },
  });
  const dispatch = vi.fn(async () => {
    throw new Error("Unexpected fallback requester run");
  });
  const send = vi.fn(async () => {
    throw new Error("Unexpected duplicate channel fallback");
  });
  testing.setDepsForTest({
    getRuntimeConfig: () => ({}),
    dispatchGatewayMethodInProcess: dispatch,
    sendMessage: send,
  });
  const receipts: SubagentAnnounceDeliveryResult[] = [];
  const controller = createLifecycleControllerFixture(
    {
      entry,
      runs,
      realWorker: true,
      // Exercise the real flow, varying only its public source-owner capability.
      runSubagentAnnounceFlow: (params) =>
        runSubagentAnnounceFlow({
          ...params,
          isCompletionDeliveryAllowed: () =>
            effectsAllowed && params.isCompletionDeliveryAllowed?.() !== false,
          onDeliveryResult: async (receipt) => {
            receipts.push(receipt);
            await params.onDeliveryResult?.(receipt);
          },
        }),
      maybeWakeRequesterAfterAllChildrenSettled: async () => false,
    },
    {
      callGateway: async () => ({}),
      cleanupBrowserSessionsForLifecycleEnd: async () => {},
      ownersByEntry: new Map(),
    },
  );
  const join = observeRootWork();
  try {
    expect(controller.startSubagentAnnounceCleanupFlow(runs.get(entry.runId)!)).toBe(true);
    await join(true);
    // The owner changed only after the steer committed, so the receipt reports delivery.
    expect(receipts[0]).toMatchObject({ delivered: true, path: "steered" });
    // Re-enter the normal resumed-cleanup path after the transient owner change.
    effectsAllowed = true;
    controller.startSubagentAnnounceCleanupFlow(runs.get(entry.runId)!);
    await join();
    const stored = loadSubagentRegistryFromSqlite().get(entry.runId)!;
    const transcript = await loadTranscriptEvents(requesterTarget);
    // The owner persists a generic carrier; the actual result is model context.
    const carrier = JSON.stringify(RUNTIME_EVENT_USER_PROMPT).slice(1, -1);
    const completionInputs = transcript.filter((event) => JSON.stringify(event).includes(carrier));
    // A committed steer is the delivery; recording it otherwise later expires a delivered result.
    expect(parentInbox).toHaveLength(1);
    expect(parentInbox[0]).toContain(resultText);
    expect(completionInputs).toHaveLength(1);
    expect(queueMessage).toHaveBeenCalledOnce();
    expect(dispatch).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(stored.completion?.resultText).toBe(resultText);
    expect(stored.delivery, JSON.stringify(stored.delivery)).toMatchObject({
      status: "delivered",
      disposition: "delivered",
    });
  } finally {
    operation.complete();
    controller.clearRuntimeState();
    await join();
  }
}, 120_000);
