import assert from "node:assert/strict";
import { expect, it } from "vitest";
import {
  getRestartRecoveryTerminalDeliveryEvidence as readEvidence,
  mergeRestartRecoveryTerminalDeliveryEvidence as mergeEvidence,
} from "../config/sessions/restart-recovery-state.js";
import {
  buildCurrentRunRestartRecoveryClaim as claim,
  buildRestartRecoveryTerminalDeliveryEvidence as capture,
} from "./agent-command-restart-recovery.js";
import { hasMessagingToolDeliveryToSource as deliveredToSource } from "./subagents/announce/subagent-announce-completion-delivery.js";

const session = { sessionId: "session-1", updatedAt: 1 };
const source = { channel: "discord", to: "channel:123" };
const target = { provider: source.channel, to: source.to };

const scopedPolicy = {
  restartRecoveryDisableMessageTool: true,
  restartRecoverySourceIngress: "internal",
  restartRecoverySourceMessageChannel: null,
  restartRecoverySourceReplyDeliveryMode: "automatic",
  restartRecoveryForceSafeTools: true,
} as const;

it("persists a scoped restart-safe policy and clears retired media constraints", () => {
  const claimed = claim({
    disableMessageTool: true,
    entry: {
      ...session,
      restartRecoveryDeliveryMediaUrls: ["/tmp/old.png"],
      restartRecoverySuppressTextDelivery: true,
    },
    forceRestartSafeTools: true,
    runId: "scoped-run",
    sourceIngress: "internal",
    sourceMessageChannel: null,
    sourceRunId: "scoped-run",
    sourceReplyDeliveryMode: "automatic",
  });
  expect(claimed).toMatchObject({
    ...scopedPolicy,
    restartRecoveryDeliveryMediaUrls: undefined,
    restartRecoverySuppressTextDelivery: undefined,
    restartRecoveryDeliveryRunId: "scoped-run",
    restartRecoveryDeliverySourceRunId: "scoped-run",
  });
});

it("preserves the claimed route when delivery preparation resolves an alias", () => {
  const claimed = claim({
    deliveryContext: { channel: "telegram", to: "telegram:-100123:topic:1", threadId: 1 },
    entry: {
      ...scopedPolicy,
      ...session,
      restartRecoveryDeliveryRunId: "recovery-run",
      restartRecoveryDeliveryContext: { channel: "telegram", to: "-100123", threadId: 1 },
    },
    runId: "recovery-run",
    sourceMessageChannel: "webchat",
  });
  expect(claimed).toMatchObject({
    ...scopedPolicy,
    restartRecoveryDeliveryContext: { channel: "telegram", to: "-100123", threadId: 1 },
    restartRecoveryDeliveryRunId: "recovery-run",
  });
});

it("requires explicit ownership for a new source claim", () => {
  const runId = "media-run";
  expect(() => claim({ entry: session, runId, sourceRunId: runId })).toThrow(
    "restart recovery source ownership is required for a new claim",
  );
});

type TerminalDeliveryInput = Parameters<typeof capture>[0];
type PayloadOutcome = NonNullable<
  NonNullable<TerminalDeliveryInput["deliveryStatus"]>["payloadOutcomes"]
>[number];

function project(result: TerminalDeliveryInput) {
  const persisted = JSON.stringify([{ runId: "original", ...capture(result) }]);
  const restartRecoveryTerminalDeliveryEvidence = JSON.parse(persisted);
  const evidence = readEvidence(
    { ...session, restartRecoveryTerminalDeliveryEvidence },
    "original",
  );
  assert(evidence, "Expected persisted restart-recovery evidence");
  return evidence;
}

const suppressedOutcomes = (reason: string, count = 65): PayloadOutcome[] =>
  Array.from({ length: count }, (_, index) => ({ index, status: "suppressed", reason }));
const suppressed = (reason: string, payloadOutcomes?: PayloadOutcome[]) => ({
  status: "suppressed" as const,
  resultCount: 0,
  reason,
  payloadOutcomes,
});
const silent = { terminalReply: { disposition: "silent" as const } };
const privateError = new Error("private synthetic failure");
// Announcement classification is covered by subagent-announce-delivery{,.yielded-settle}.test.ts;
// this owner proves the exact facts surviving persistence, including private-error redaction.
it.each<[string, TerminalDeliveryInput, Partial<ReturnType<typeof capture>>]>([
  ["silent final", { meta: silent }, { meta: silent }],
  ["yielded", { meta: { ...silent, yielded: true } }, { meta: { ...silent, yielded: true } }],
  [
    "pending",
    { meta: { ...silent, continuationPending: true } },
    { meta: { ...silent, continuationPending: true } },
  ],
  ["aborted", { meta: { ...silent, aborted: true } }, { meta: { ...silent, aborted: true } }],
  ["failed", { meta: { ...silent, error: privateError } }, { meta: { ...silent, error: true } }],
  [
    "settled",
    { meta: { yielded: true }, requesterContinuationSettled: true },
    { meta: { yielded: true }, requesterContinuationSettled: true },
  ],
  ["empty", { payloads: [] }, {}],
])("persists %s completion facts", (_name, input, expected) => {
  expect(project(input)).toEqual({ runId: "original", captured: true, ...expected });
});

it.each<Omit<PayloadOutcome, "index">>([
  { status: "suppressed", reason: "adapter_returned_no_identity" },
  { status: "failed", sentBeforeError: true },
  { status: "sent" },
])("retains truncated $status send evidence", (lastOutcome) => {
  const original = {
    payloads: Array.from({ length: 65 }, () => ({ text: "progress", isCommentary: true })),
    deliveryStatus: suppressed("cancelled_by_message_sending_hook", [
      ...suppressedOutcomes("cancelled_by_message_sending_hook", 64),
      { index: 64, ...lastOutcome },
    ]),
  } satisfies TerminalDeliveryInput;
  const stored = project(original);
  expect(stored?.deliveryStatus?.payloadOutcomes).toHaveLength(64);
  expect(stored?.deliveryStatus?.payloadOutcomes?.[63]).toEqual({ index: 64, ...lastOutcome });
});

it("preserves late policy cancellation beyond the bounded outcome list", () => {
  const original = {
    deliveryStatus: suppressed("no_visible_payload", [
      ...suppressedOutcomes("no_visible_payload", 64),
      { index: 64, status: "suppressed", reason: "cancelled_by_message_sending_hook" },
    ]),
  } satisfies TerminalDeliveryInput;
  expect(project(original).deliveryStatus?.reason).toBe("cancelled_by_message_sending_hook");
});

it("bounds suppression reasons and outcomes without retaining raw terminal objects", () => {
  const evidence = project({
    meta: {
      terminalReply: { disposition: "silent", text: "discarded" },
      error: new Error("discarded"),
    },
    deliveryStatus: {
      status: "suppressed",
      reason: "x".repeat(300),
      payloadOutcomes: suppressedOutcomes("y".repeat(300)),
    },
  });
  expect(evidence?.meta).toEqual({ terminalReply: { disposition: "silent" }, error: true });
  expect(evidence?.deliveryStatus?.reason).toHaveLength(256);
  expect(evidence?.deliveryStatus?.payloadOutcomes).toHaveLength(64);
  expect(evidence?.deliveryStatus?.payloadOutcomes?.[0]?.reason).toHaveLength(256);
  expect(JSON.stringify(evidence)).not.toContain("discarded");
  const runs = Array.from({ length: 65 }, (_, index) => ({ ...evidence, runId: `run-${index}` }));
  const receipts = mergeEvidence(undefined, runs);
  expect([receipts?.length, receipts?.[0]?.runId]).toEqual([64, "run-1"]);
});

it("does not promote malformed persisted completion markers into authority", () => {
  const [receipt] = mergeEvidence(undefined, [
    {
      runId: "malformed",
      captured: true,
      meta: {
        terminalReply: { disposition: "visible", text: "unbounded" },
        yielded: "true",
        aborted: 1,
        error: {},
      },
      requesterContinuationSettled: "true",
      deliveryStatus: { status: "suppressed", reason: { message: "invalid" } },
    },
  ])!;
  expect(receipt).toBeDefined();
  expect(receipt?.meta).toBeUndefined();
  expect(receipt?.requesterContinuationSettled).toBeUndefined();
  expect(receipt?.deliveryStatus?.reason).toBeUndefined();
});

it.each([false, true])("retains source final=%s through replay", (sourceReplyFinal) => {
  const stored = project({
    messagingToolSentTargets: [{ ...target, text: "reply", sourceReplyFinal }],
  });
  expect(stored?.messagingToolSentTargets?.[0]?.sourceReplyFinal).toBe(sourceReplyFinal);
  expect(deliveredToSource(stored!, source, { requireFinalReply: true })).toBe(sourceReplyFinal);
});

it.each([1, undefined])("preserves automatic result count=%s", (resultCount) => {
  const stored = project({ deliveryStatus: { status: "sent", resultCount } });
  expect(stored?.deliveryStatus?.resultCount).toBe(resultCount);
});

it("marks bounded messaging-tool target evidence as truncated", () => {
  const evidence = capture({
    messagingToolSentTargets: Array.from({ length: 65 }, (_, index) => ({
      provider: "discord",
      to: `channel:${index}`,
      text: "sent",
    })),
  });

  expect(evidence?.messagingToolSentTargets).toHaveLength(64);
  expect(evidence?.messagingToolSentTargetsTruncated).toBe(true);
});

it.each([
  { name: "literal silence token", payload: { text: "NO_REPLY" }, expected: { visible: true } },
  {
    name: "explicitly hidden payload",
    payload: { visible: false, mediaUrls: ["/tmp/private.png"] },
    expected: { mediaUrls: ["/tmp/private.png"], visible: false },
  },
])("preserves $name visibility", ({ payload, expected }) => {
  const evidence = capture({ payloads: [payload] });
  expect(evidence.payloads).toEqual([expected]);
  expect(evidence.meta?.terminalReply).toBeUndefined();
});

it("retains mixed unaccounted aggregate delivery as ambiguous evidence", () => {
  const evidence = capture({
    didSendViaMessagingTool: true,
    messagingToolSentMediaUrls: ["/tmp/one.png", "/tmp/two.png"],
    messagingToolSentTargets: [{ ...target, mediaUrls: ["/tmp/one.png"] }],
  });

  expect(evidence?.messagingToolAggregateEvidenceUnaccounted).toBe(true);
  expect(evidence?.messagingToolSentTargets).toEqual([
    { ...target, mediaUrls: ["/tmp/one.png"], visible: true },
  ]);
});

it("preserves explicit negative messaging-target visibility", () => {
  const evidence = capture({
    messagingToolSentTargets: [{ ...target, text: "" }],
  });

  expect(evidence?.messagingToolSentTargets).toEqual([{ ...target, visible: false }]);
});
