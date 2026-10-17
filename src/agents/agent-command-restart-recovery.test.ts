import { describe, expect, it } from "vitest";
import type { ReplyPayload } from "../auto-reply/reply-payload.js";
import {
  getRestartRecoveryTerminalDeliveryEvidence,
  mergeRestartRecoveryTerminalDeliveryEvidence,
} from "../config/sessions/restart-recovery-state.js";
import {
  buildCurrentRunRestartRecoveryClaim,
  buildRestartRecoveryTerminalDeliveryEvidence,
  constrainRestartRecoveryDeliveryPayloads,
} from "./agent-command-restart-recovery.js";
import { hasMessagingToolDeliveryToSource } from "./subagents/announce/subagent-announce-completion-delivery.js";
import { createDirectAnnounceResponseClassifier } from "./subagents/announce/subagent-announce-direct-response.js";

describe("buildCurrentRunRestartRecoveryClaim", () => {
  const mediaPolicy = {
    restartRecoveryDisableMessageTool: true,
    restartRecoverySourceIngress: "internal",
    restartRecoverySourceReplyDeliveryMode: "automatic",
    restartRecoveryForceSafeTools: true,
    restartRecoverySuppressTextDelivery: true,
  } as const;

  it("persists the complete generated-media policy, including an empty allowlist", () => {
    expect(
      buildCurrentRunRestartRecoveryClaim({
        deliveryMediaUrls: [],
        disableMessageTool: true,
        entry: { sessionId: "session-1", updatedAt: 1 },
        forceRestartSafeTools: true,
        runId: "media-run",
        sourceIngress: "internal",
        sourceRunId: "media-run",
        sourceReplyDeliveryMode: "automatic",
        suppressTextDelivery: true,
      }),
    ).toEqual({
      ...mediaPolicy,
      restartRecoveryDeliveryContext: undefined,
      restartRecoveryDeliveryMediaUrls: [],
      restartRecoveryDeliveryRunId: "media-run",
      restartRecoveryDeliverySourceRunId: "media-run",
    });
  });

  it("preserves the claimed route when delivery preparation resolves an alias", () => {
    expect(
      buildCurrentRunRestartRecoveryClaim({
        deliveryContext: {
          channel: "telegram",
          to: "telegram:-100123:topic:1",
          threadId: 1,
        },
        entry: {
          ...mediaPolicy,
          sessionId: "session-1",
          updatedAt: 1,
          restartRecoveryDeliveryRunId: "recovery-run",
          restartRecoveryDeliveryContext: { channel: "telegram", to: "-100123", threadId: 1 },
        },
        runId: "recovery-run",
      }),
    ).toMatchObject({
      ...mediaPolicy,
      restartRecoveryDeliveryContext: { channel: "telegram", to: "-100123", threadId: 1 },
      restartRecoveryDeliveryRunId: "recovery-run",
    });
  });

  it("requires explicit ownership for a new source claim", () => {
    expect(() =>
      buildCurrentRunRestartRecoveryClaim({
        entry: { sessionId: "session-1", updatedAt: 1 },
        runId: "media-run",
        sourceRunId: "media-run",
      }),
    ).toThrow("restart recovery source ownership is required for a new claim");
  });
});

describe("constrainRestartRecoveryDeliveryPayloads", () => {
  const mediaReply = {
    text: "ready",
    mediaUrl: "/tmp/missing.png",
    mediaUrls: ["/tmp/missing.png"],
    trustedLocalMedia: true,
  };
  const mediaOnly = { mediaUrls: ["/tmp/missing.png"], trustedLocalMedia: true };
  it.each<{
    name: string;
    payloads: ReplyPayload[];
    media?: string[];
    expected: ReplyPayload[];
  }>([
    {
      name: "replaces model media with the exact host-owned set",
      payloads: [
        {
          text: "ready",
          mediaUrl: "/tmp/old.png",
          mediaUrls: ["/tmp/old-2.png"],
          trustedLocalMedia: true,
          audioAsVoice: true,
          ...({ attachments: [{ url: "/tmp/nested-old.png" }] } as Record<string, unknown>),
        },
      ],
      media: [" /tmp/missing.png ", "/tmp/missing.png"],
      expected: [mediaReply],
    },
    {
      name: "does not attach host-owned media to commentary, notices, or errors",
      payloads: [
        { text: "commentary", isCommentary: true },
        { text: "status", isStatusNotice: true },
        { text: "failed attempt", isError: true },
        { text: "ready" },
      ],
      expected: [
        { text: "commentary", isCommentary: true },
        { text: "status", isStatusNotice: true },
        { text: "failed attempt", isError: true },
        mediaReply,
      ],
    },
    {
      name: "keeps host-owned media separate when no visible successful reply exists",
      payloads: [{ text: "failed attempt", isError: true }],
      expected: [{ text: "failed attempt", isError: true }, mediaOnly],
    },
    {
      name: "strips all model media from a text-only notice",
      payloads: [{ text: "failed", mediaUrls: ["/tmp/unrelated.png"], sensitiveMedia: true }],
      media: [],
      expected: [{ text: "failed" }],
    },
  ])("$name", ({ payloads, media = ["/tmp/missing.png"], expected }) => {
    expect(constrainRestartRecoveryDeliveryPayloads(payloads, media)).toEqual(expected);
  });
});

describe("buildRestartRecoveryTerminalDeliveryEvidence", () => {
  type TerminalDeliveryInput = Parameters<typeof buildRestartRecoveryTerminalDeliveryEvidence>[0];
  type PayloadOutcome = NonNullable<
    NonNullable<TerminalDeliveryInput["deliveryStatus"]>["payloadOutcomes"]
  >[number];

  function project(result: TerminalDeliveryInput) {
    const persisted = JSON.stringify([
      { runId: "original", ...buildRestartRecoveryTerminalDeliveryEvidence(result) },
    ]);
    return getRestartRecoveryTerminalDeliveryEvidence(
      {
        sessionId: "session-1",
        updatedAt: 1,
        restartRecoveryTerminalDeliveryEvidence: JSON.parse(persisted),
      },
      "original",
    );
  }

  const classify = createDirectAnnounceResponseClassifier({
    params: {
      sourceTool: "subagent_settle",
      expectsCompletionMessage: false,
      requesterIsSubagent: false,
    },
    parentOnly: false,
    requesterSessionBound: true,
    replyExpectation: "optional",
    deliveryTarget: {},
    shouldDeliverAgentFinal: true,
    requiresMessageToolDelivery: false,
    isSubagentCompletion: false,
    hasSuccessfulTrustedSubagentNoOutputCompletion: false,
    hasRequiredSubagentNoOutputCompletion: false,
    subagentDirectMessageCompletionRequiresMessageTool: false,
    effectiveDirectOrigin: undefined,
    requesterSessionOrigin: undefined,
    textCompletionDirectDeliveryKind: "completed_result",
    tryTextCompletionDirectDelivery: async () => undefined,
  });

  it.each([
    {
      name: "intentional silent final",
      result: { meta: { terminalReply: { disposition: "silent" } } },
      delivered: true,
    },
    {
      name: "unsettled yielded silence",
      result: { meta: { terminalReply: { disposition: "silent" }, yielded: true } },
      delivered: false,
    },
    {
      name: "pending continuation",
      result: { meta: { terminalReply: { disposition: "silent" }, continuationPending: true } },
      delivered: false,
    },
    {
      name: "aborted silent run",
      result: { meta: { terminalReply: { disposition: "silent" }, aborted: true } },
      delivered: false,
    },
    {
      name: "failed silent run",
      result: {
        meta: {
          terminalReply: { disposition: "silent" },
          error: new Error("private synthetic failure"),
        },
      },
      delivered: false,
    },
    {
      name: "host-settled yielded continuation",
      result: { meta: { yielded: true }, requesterContinuationSettled: true },
      delivered: true,
    },
    { name: "legacy empty receipt", result: { payloads: [] }, delivered: false },
  ])("replays $name without inventing visible delivery", async ({ result, delivered }) => {
    const stored = project(result);
    const delivery = await classify({ status: "ok", result: stored });
    expect(delivery).toMatchObject({ delivered, path: "direct" });
    expect(JSON.stringify(stored)).not.toContain("private synthetic failure");
    if (!delivered) {
      expect(delivery).toMatchObject({ reason: "visible_reply_missing" });
    }
  });

  it.each([
    { reason: "no_visible_payload", expected: { reason: "visible_reply_missing" } },
    { reason: "message_tool_only", expected: { reason: "visible_reply_missing" } },
    { reason: "adapter_returned_no_identity", expected: { disposition: "ambiguous" } },
    {
      reason: "cancelled_by_message_sending_hook",
      expected: { disposition: "intentional_non_delivery", reason: "delivery_suppressed" },
    },
  ] as const)(
    "preserves automatic suppression $reason across receipt replay",
    async ({ reason, expected }) => {
      const stored = project({
        payloads: [],
        meta: { yielded: true },
        deliveryStatus: { status: "suppressed", resultCount: 0, reason },
      });
      expect(await classify({ status: "ok", result: stored })).toMatchObject({
        delivered: false,
        ...expected,
      });
    },
  );

  it.each([
    { status: "suppressed", reason: "adapter_returned_no_identity" },
    { status: "failed", sentBeforeError: true },
    { status: "sent" },
  ] satisfies Array<Omit<PayloadOutcome, "index">>)(
    "retains omitted $status send evidence instead of acknowledging policy suppression",
    async (lastOutcome) => {
      const original = {
        payloads: Array.from({ length: 65 }, () => ({ text: "progress", isCommentary: true })),
        deliveryStatus: {
          status: "suppressed",
          resultCount: 0,
          reason: "cancelled_by_message_sending_hook",
          payloadOutcomes: [
            ...Array.from({ length: 64 }, (_, index): PayloadOutcome => ({
              index,
              status: "suppressed",
              reason: "cancelled_by_message_sending_hook",
            })),
            { index: 64, ...lastOutcome },
          ],
        },
      } satisfies TerminalDeliveryInput;
      expect(await classify({ status: "ok", result: original })).toMatchObject({
        delivered: false,
        disposition: "ambiguous",
      });
      const stored = project(original);
      expect(stored?.deliveryStatus?.payloadOutcomes).toHaveLength(64);
      expect(stored?.deliveryStatus?.payloadOutcomes?.[63]).toEqual({ index: 64, ...lastOutcome });
      expect(await classify({ status: "ok", result: stored })).toMatchObject({
        delivered: false,
        disposition: "ambiguous",
      });
    },
  );

  it("preserves late policy cancellation beyond the bounded outcome list", async () => {
    const original = {
      deliveryStatus: {
        status: "suppressed",
        resultCount: 0,
        reason: "no_visible_payload",
        payloadOutcomes: Array.from({ length: 65 }, (_, index): PayloadOutcome => ({
          index,
          status: "suppressed",
          reason: index < 64 ? "no_visible_payload" : "cancelled_by_message_sending_hook",
        })),
      },
    } satisfies TerminalDeliveryInput;
    const expected = {
      delivered: false,
      disposition: "intentional_non_delivery",
      reason: "delivery_suppressed",
    };
    expect(await classify({ status: "ok", result: original })).toMatchObject(expected);
    expect(await classify({ status: "ok", result: project(original) })).toMatchObject(expected);
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
        payloadOutcomes: Array.from({ length: 65 }, (_, index): PayloadOutcome => ({
          index,
          status: "suppressed",
          reason: "y".repeat(300),
        })),
      },
    });
    expect(evidence?.meta).toEqual({ terminalReply: { disposition: "silent" }, error: true });
    expect(evidence?.deliveryStatus?.reason).toHaveLength(256);
    expect(evidence?.deliveryStatus?.payloadOutcomes).toHaveLength(64);
    expect(evidence?.deliveryStatus?.payloadOutcomes?.[0]?.reason).toHaveLength(256);
    expect(JSON.stringify(evidence)).not.toContain("discarded");
    const receipts = mergeRestartRecoveryTerminalDeliveryEvidence(
      undefined,
      Array.from({ length: 65 }, (_, index) => ({ ...evidence, runId: `run-${index}` })),
    );
    expect(receipts).toHaveLength(64);
    expect(receipts?.[0]?.runId).toBe("run-1");
  });

  it("does not promote malformed persisted completion markers into authority", () => {
    const [receipt] = mergeRestartRecoveryTerminalDeliveryEvidence(undefined, [
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

  it.each([false, true])(
    "retains the source final marker %s through durable projection",
    (sourceReplyFinal) => {
      const original = {
        messagingToolSentTargets: [
          {
            provider: "discord",
            to: "channel:123",
            text: "reply",
            sourceReplyFinal,
          },
        ],
      };
      const stored = project(original);
      expect(stored?.messagingToolSentTargets?.[0]?.sourceReplyFinal).toBe(sourceReplyFinal);
      expect(
        hasMessagingToolDeliveryToSource(
          stored!,
          { channel: "discord", to: "channel:123" },
          { requireFinalReply: true },
        ),
      ).toBe(sourceReplyFinal);
    },
  );

  it.each([1, undefined])(
    "preserves automatic result count %s without manufacturing a send",
    (resultCount) => {
      const stored = project({ deliveryStatus: { status: "sent", resultCount } });
      expect(stored?.deliveryStatus?.resultCount).toBe(resultCount);
    },
  );

  it("marks bounded messaging-tool target evidence as truncated", () => {
    const evidence = buildRestartRecoveryTerminalDeliveryEvidence({
      messagingToolSentTargets: Array.from({ length: 65 }, (_, index) => ({
        provider: "discord",
        to: `channel:${index}`,
        text: "sent",
      })),
    });

    expect(evidence?.messagingToolSentTargets).toHaveLength(64);
    expect(evidence?.messagingToolSentTargetsTruncated).toBe(true);
  });

  it("preserves a prepared literal token as visible without inventing a silence fact", () => {
    const evidence = buildRestartRecoveryTerminalDeliveryEvidence({
      payloads: [{ text: "NO_REPLY" }],
    });
    expect(evidence.payloads).toEqual([{ visible: true }]);
    expect(evidence.meta?.terminalReply).toBeUndefined();
  });

  it("preserves explicit hidden-payload visibility", () => {
    const evidence = buildRestartRecoveryTerminalDeliveryEvidence({
      payloads: [{ visible: false, mediaUrls: ["/tmp/private.png"] }],
    });

    expect(evidence?.payloads).toEqual([{ mediaUrls: ["/tmp/private.png"], visible: false }]);
  });

  it("retains mixed unaccounted aggregate delivery as ambiguous evidence", () => {
    const evidence = buildRestartRecoveryTerminalDeliveryEvidence({
      didSendViaMessagingTool: true,
      messagingToolSentMediaUrls: ["/tmp/one.png", "/tmp/two.png"],
      messagingToolSentTargets: [
        { provider: "discord", to: "channel:123", mediaUrls: ["/tmp/one.png"] },
      ],
    });

    expect(evidence?.messagingToolAggregateEvidenceUnaccounted).toBe(true);
    expect(evidence?.messagingToolSentTargets).toEqual([
      {
        provider: "discord",
        to: "channel:123",
        mediaUrls: ["/tmp/one.png"],
        visible: true,
      },
    ]);
  });

  it("preserves explicit negative messaging-target visibility", () => {
    const evidence = buildRestartRecoveryTerminalDeliveryEvidence({
      messagingToolSentTargets: [{ provider: "discord", to: "channel:123", text: "" }],
    });

    expect(evidence?.messagingToolSentTargets).toEqual([
      { provider: "discord", to: "channel:123", visible: false },
    ]);
  });
});
