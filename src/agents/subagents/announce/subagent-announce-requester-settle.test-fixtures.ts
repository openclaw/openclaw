import type { deliverSubagentAnnouncement } from "./subagent-announce-delivery.test-support.js";

type AnnouncementInput = Parameters<typeof deliverSubagentAnnouncement>[0];

export function createRequesterSettleCases() {
  const requesterSettleSourceTarget = {
    tool: "message",
    provider: "discord",
    accountId: "acct-1",
    to: "dm:U123",
    text: "the consolidated answer",
  };
  const sourceProgress = { ...requesterSettleSourceTarget, sourceReplyFinal: false };
  const sourceFinal = { ...requesterSettleSourceTarget, sourceReplyFinal: true };
  const deliveredRequesterFinal = { delivered: true, path: "direct" };
  const missingRequesterFinal = {
    delivered: false,
    path: "direct",
    reason: "visible_reply_missing",
  };
  const suppressedDelivery = { status: "suppressed", succeeded: true, resultCount: 0 };
  const finalText = "The consolidated answer.";

  function settleRoute(
    name: string,
    sessionKey: string,
    origin: AnnouncementInput["requesterSessionOrigin"],
    channel?: string,
    deliver = false,
    requesterIsSubagent = false,
  ) {
    return {
      name,
      sessionKey,
      origin,
      requesterIsSubagent,
      agentParams: {
        deliver,
        channel,
        accountId: deliver ? "acct-1" : undefined,
        to: deliver ? "dm:U123" : undefined,
      },
    };
  }
  const externalRequesterSettleRoute = settleRoute(
    "Discord",
    "agent:main:discord:dm:U123",
    { channel: "discord", to: "dm:U123", accountId: "acct-1" },
    "discord",
    true,
  );
  const localRequesterSettleRoute = settleRoute(
    "no origin",
    "agent:main:requester-settle",
    undefined,
  );
  const localSettleRoutes = [
    localRequesterSettleRoute,
    settleRoute(
      "WebChat",
      "agent:main:webchat:dm:requester-settle",
      { channel: "webchat" },
      "webchat",
    ),
    settleRoute(
      "nested requester with inherited Discord origin",
      "agent:main:subagent:requester-settle",
      externalRequesterSettleRoute.origin,
      undefined,
      false,
      true,
    ),
  ];
  type SettleCaseOptions = {
    routes?: ReturnType<typeof settleRoute>[];
    status?: string;
    requireVisibleReply?: boolean;
    recordsVisibleFinal?: boolean;
    expectedFinalText?: string;
    expected?: Record<string, unknown>;
  };
  function settleCase(
    name: string,
    result?: Record<string, unknown>,
    options: SettleCaseOptions = {},
  ) {
    return {
      name,
      result,
      routes: [externalRequesterSettleRoute],
      requireVisibleReply: true,
      expected: missingRequesterFinal,
      ...options,
    };
  }
  const localOnly = { routes: [localRequesterSettleRoute] };
  const visibleFinal = { recordsVisibleFinal: true, expected: deliveredRequesterFinal };
  const requesterSettleCases = [
    ...[
      {
        name: "automatic delivery",
        evidence: { deliveryStatus: { status: "sent", succeeded: true, resultCount: 1 } },
      },
      { name: "final message tool", evidence: { messagingToolSentTargets: [sourceFinal] } },
    ].map(({ name, evidence }) =>
      settleCase(
        `preserves ${name} final evidence alongside settled continuation`,
        { payloads: [], meta: { yielded: true }, requesterContinuationSettled: true, ...evidence },
        visibleFinal,
      ),
    ),
    settleCase(
      "acknowledges a core-settled next wave without recording a visible final",
      { payloads: [], meta: { yielded: true }, requesterContinuationSettled: true },
      { expected: deliveredRequesterFinal },
    ),
    ...[
      { settled: undefined, error: undefined, aborted: undefined },
      { settled: true, error: { kind: "incomplete_turn" }, aborted: undefined },
      { settled: true, error: undefined, aborted: true },
    ].map(({ settled, error, aborted }) =>
      settleCase(
        `rejects unproven or failed continuation (true/${settled}/${Boolean(error)}/${aborted})`,
        {
          payloads: [],
          meta: { yielded: true, error, aborted },
          requesterContinuationSettled: settled,
          acceptedSessionSpawns: [{ runId: "child", childSessionKey: "agent:main:subagent:child" }],
        },
        localOnly,
      ),
    ),
    ...["accepted", "in_flight"].map((status) =>
      settleCase(`retains an ${status} settle handoff until terminal evidence`, undefined, {
        status,
        expected: { delivered: false, disposition: "session_queued" },
      }),
    ),
    settleCase(
      "does not record a canceled partial answer as a visible final",
      { payloads: [{ text: "partial answer" }] },
      { ...localOnly, status: "timeout", expected: deliveredRequesterFinal },
    ),
    settleCase(
      "records a non-yielded visible final without requiring a reply",
      {
        payloads: [{ text: finalText }],
        meta: {
          finalAssistantVisibleText: finalText,
          terminalReply: { disposition: "visible", text: finalText },
        },
      },
      {
        ...visibleFinal,
        routes: localSettleRoutes,
        requireVisibleReply: false,
        expectedFinalText: finalText,
      },
    ),
    settleCase(
      "preserves an ordinary non-yielded direct settle turn",
      { payloads: [], meta: { terminalReply: { disposition: "silent" } } },
      {
        requireVisibleReply: false,
        expected: deliveredRequesterFinal,
      },
    ),
    settleCase(
      "rejects a yielded turn that emits only the silent reply token",
      { payloads: [], meta: { yielded: true, terminalReply: { disposition: "silent" } } },
      localOnly,
    ),
    settleCase(
      "rejects a visible final whose delivery was suppressed",
      { payloads: [{ text: "never delivered" }], deliveryStatus: suppressedDelivery },
      localOnly,
    ),
    settleCase("rejects a messaging-tool flag without a committed source receipt", {
      payloads: [{ text: finalText }],
      didSendViaMessagingTool: true,
    }),
    settleCase("does not let an off-target final upgrade source progress", {
      payloads: [{ text: finalText }],
      didSendViaMessagingTool: true,
      messagingToolSentTargets: [sourceProgress, { ...sourceFinal, to: "dm:OTHER" }],
    }),
    settleCase(
      "accepts an automatic source-matched final without legacy intent markers",
      {
        payloads: [{ text: "NO_REPLY" }],
        didSendViaMessagingTool: true,
        messagingToolSentTargets: [requesterSettleSourceTarget],
      },
      visibleFinal,
    ),
    settleCase(
      "accepts a source final after source progress in the same turn",
      {
        payloads: [],
        didSendViaMessagingTool: true,
        messagingToolSentTargets: [sourceProgress, sourceFinal],
      },
      visibleFinal,
    ),
    settleCase(
      "accepts a committed source final when automatic delivery was suppressed",
      {
        payloads: [{ text: "NO_REPLY" }],
        deliveryStatus: suppressedDelivery,
        didSendViaMessagingTool: true,
        messagingToolSentTargets: [sourceFinal],
      },
      visibleFinal,
    ),
    settleCase(
      "rejects terminal text when an external origin cannot be resolved",
      { payloads: [{ text: finalText }] },
      {
        routes: [
          settleRoute(
            "external channel without destination",
            "agent:main:requester-settle",
            { channel: "discord" },
            "discord",
          ),
          settleRoute("destination without channel", "agent:main:requester-settle", {
            to: "dm:U123",
          }),
          settleRoute("unknown channel", "agent:main:requester-settle", {
            channel: "unknown-external",
            to: "dm:U123",
          }),
        ],
      },
    ),
  ];
  return requesterSettleCases;
}
