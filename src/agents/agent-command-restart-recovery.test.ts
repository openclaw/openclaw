import { describe, expect, it } from "vitest";
import type { ReplyPayload } from "../auto-reply/reply-payload.js";
import { getRestartRecoveryTerminalDeliveryEvidence } from "../config/sessions/restart-recovery-state.js";
import {
  buildCurrentRunRestartRecoveryClaim,
  buildRestartRecoveryTerminalDeliveryEvidence,
  constrainRestartRecoveryDeliveryPayloads,
} from "./agent-command-restart-recovery.js";
import { hasMessagingToolDeliveryToSource } from "./subagents/announce/subagent-announce-completion-delivery.js";

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

  it("preserves a preclaimed recovery policy", () => {
    expect(
      buildCurrentRunRestartRecoveryClaim({
        entry: {
          ...mediaPolicy,
          sessionId: "session-1",
          updatedAt: 1,
          restartRecoveryDeliveryContext: {
            channel: "discord",
            to: "channel:123",
            accountId: "main",
            threadId: "42",
          },
          restartRecoveryDeliveryRunId: "recovery-run",
          restartRecoveryDeliverySourceRunId: "media-run",
          restartRecoveryDeliveryMediaUrls: ["/tmp/proof.png"],
        },
        runId: "recovery-run",
      }),
    ).toEqual({
      ...mediaPolicy,
      restartRecoveryDeliveryContext: {
        channel: "discord",
        to: "channel:123",
        accountId: "main",
        threadId: "42",
      },
      restartRecoveryDeliveryMediaUrls: ["/tmp/proof.png"],
      restartRecoveryDeliveryRunId: "recovery-run",
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
          sessionId: "session-1",
          updatedAt: 1,
          restartRecoveryDeliveryRunId: "recovery-run",
          restartRecoveryDeliveryContext: { channel: "telegram", to: "-100123", threadId: 1 },
        },
        runId: "recovery-run",
      }),
    ).toMatchObject({
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
    suppressText?: boolean;
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
      name: "attaches host-owned media to the first visible reply after reasoning",
      payloads: [
        { text: "thinking", isReasoning: true, mediaUrls: ["/tmp/model-reasoning.png"] },
        { text: "ready", mediaUrls: ["/tmp/model-selected.png"] },
      ],
      media: [" /tmp/missing.png ", "/tmp/missing.png"],
      expected: [{ text: "thinking", isReasoning: true }, mediaReply],
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
    {
      name: "suppresses model text on a media-only repair attempt",
      payloads: [{ text: "caption already sent", mediaUrls: ["/tmp/old.png"] }],
      suppressText: true,
      expected: [mediaOnly],
    },
  ])("$name", ({ payloads, media = ["/tmp/missing.png"], suppressText, expected }) => {
    expect(constrainRestartRecoveryDeliveryPayloads(payloads, media, suppressText)).toEqual(
      expected,
    );
  });
});

describe("buildRestartRecoveryTerminalDeliveryEvidence", () => {
  function project(result: Parameters<typeof buildRestartRecoveryTerminalDeliveryEvidence>[0]) {
    return getRestartRecoveryTerminalDeliveryEvidence(
      {
        sessionId: "session-1",
        updatedAt: 1,
        restartRecoveryTerminalDeliveryEvidence: [
          { runId: "original", ...buildRestartRecoveryTerminalDeliveryEvidence(result) },
        ],
      },
      "original",
    );
  }

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

  it.each([0, 1, undefined])(
    "preserves automatic result count %s without manufacturing a send",
    (resultCount) => {
      const stored = project({ deliveryStatus: { status: "sent", resultCount } });
      expect(stored?.deliveryStatus?.resultCount).toBe(resultCount);
    },
  );

  it("marks an empty terminal result as captured", () => {
    expect(buildRestartRecoveryTerminalDeliveryEvidence({})).toEqual({ captured: true });
  });

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

  it.each([
    ["reasoning", { text: "Working", isReasoning: true }],
    ["commentary", { text: "Working", isCommentary: true }],
    ["status notice", { text: "Working", isStatusNotice: true }],
    ["error", { text: "Failed", isError: true }],
    ["silent reply", { text: "NO_REPLY" }],
  ])("does not turn %s into a durable visible-final receipt", (_name, payload) => {
    const evidence = buildRestartRecoveryTerminalDeliveryEvidence({ payloads: [payload] });
    expect(evidence.payloads).toEqual([{ visible: false }]);
  });

  it("preserves explicit hidden-payload visibility", () => {
    const evidence = buildRestartRecoveryTerminalDeliveryEvidence({
      payloads: [{ visible: false, mediaUrls: ["/tmp/private.png"] }],
    });

    expect(evidence?.payloads).toEqual([{ mediaUrls: ["/tmp/private.png"], visible: false }]);
  });

  it("retains aggregate-only messaging-tool delivery as ambiguous evidence", () => {
    const evidence = buildRestartRecoveryTerminalDeliveryEvidence({
      didSendViaMessagingTool: true,
      messagingToolSentMediaUrls: ["/tmp/proof.png"],
    });

    expect(evidence).toEqual({
      captured: true,
      messagingToolAggregateEvidenceUnaccounted: true,
      restartUnsafeSideEffectsDetected: true,
    });
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

  it("retains restart-unsafe committed side effects", () => {
    const evidence = buildRestartRecoveryTerminalDeliveryEvidence({ successfulCronAdds: 1 });

    expect(evidence).toEqual({ captured: true, restartUnsafeSideEffectsDetected: true });
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
