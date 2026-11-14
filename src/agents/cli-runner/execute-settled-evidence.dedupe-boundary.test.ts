// The boundary the bounded settled-evidence holder has to keep working: the
// real delivery consumer. `filterMessagingToolReplyPayload` decides whether a
// reply the host is about to deliver was already sent by a `message` tool call,
// and it decides that by comparing the *exported* text of each settled send.
// So dropping a body for want of retention budget costs that route its
// duplicate suppression unless the holder exports comparison evidence in the
// body's place — the scenario is sequential 2 MiB sends to one Slack route
// followed by a repeat of the last body, which the run must not send twice.
//
// Real on both sides: the production consumer pair (`createCliEventHandlers`
// over `createCliToolTracking`) produces the evidence, and the production
// `filterMessagingToolReplyPayload` consumes the projection the Gateway gets.
import { describe, expect, it } from "vitest";
import { filterMessagingToolReplyPayload } from "../../auto-reply/reply/reply-payloads-dedupe.js";
import { buildPreparedCliRunContext } from "../cli-runner.test-helpers.js";
import { MAX_SETTLED_MESSAGING_EVIDENCE_CHARS } from "./execute-event-retention.js";
import { createCliEventHandlers } from "./execute-events.js";
import { createCliToolTracking } from "./execute-tool-tracking.js";
import type { PreparedCliRunContext } from "./types.js";

const SEND_CHARS = 2 * 1024 * 1024;
const SENDS = 5;
const sendBody = (index: number): string => `${index}:${"x".repeat(SEND_CHARS)}`;

/** Sequentially settled sends to one route, exactly as the CLI emits them. */
function settleSequentialSends() {
  const context = buildPreparedCliRunContext({
    runId: "settled-evidence-dedupe",
    sessionKey: "agent:main:slack:channel:c1",
  });
  const toolTracking = createCliToolTracking(context as PreparedCliRunContext);
  const handlers = createCliEventHandlers({
    context: context as PreparedCliRunContext,
    toolTracking,
    getRunState: () => ({ failed: false, error: undefined }),
  });
  for (let index = 0; index < SENDS; index += 1) {
    handlers.emitParsedToolUseStart({
      toolCallId: `send-${index}`,
      name: "mcp__openclaw__message",
      kind: "mcp_tool_use",
      args: { action: "send", channel: "slack", target: "c1", content: sendBody(index) },
    });
    handlers.emitParsedToolResult({
      toolCallId: `send-${index}`,
      name: "mcp__openclaw__message",
      isError: false,
      result: {
        details: {
          messageDelivery: {
            status: "settled",
            partialDelivery: false,
            createdThreadIds: [],
            sourceReplyDelivered: true,
          },
        },
      },
    });
  }
  return toolTracking.withExecutionEvidence({ text: "" });
}

describe("settled CLI delivery evidence at the reply-dedupe boundary", () => {
  it("suppresses a repeat of a body the retention budget dropped", () => {
    expect(SEND_CHARS * SENDS).toBeGreaterThan(MAX_SETTLED_MESSAGING_EVIDENCE_CHARS);
    const evidence = settleSequentialSends();
    const repeated = sendBody(SENDS - 1);
    // Precondition: this body is gone from both exported text collections, so
    // only route-scoped comparison evidence can recognize it.
    expect(evidence.messagingToolSentTexts).not.toContain(repeated);
    const targets = evidence.messagingToolSentTargets ?? [];
    expect(targets.filter((target) => target.text === repeated)).toHaveLength(0);

    const filter = (sentTargets: typeof targets) =>
      filterMessagingToolReplyPayload({
        payload: { text: repeated },
        messageProvider: "slack",
        originatingTo: "channel:c1",
        messagingToolSentTargets: sentTargets,
        sentTexts: evidence.messagingToolSentTexts ?? [],
      });

    expect(filter(targets)).toEqual([]);
    // Control: without the exported digest the consumer cannot see the repeat,
    // which is the duplicate delivery this evidence exists to prevent.
    const withoutDigests = targets.map(({ textComparisonDigest: _dropped, ...rest }) => rest);
    expect(filter(withoutDigests)).toHaveLength(1);
  });

  it("still delivers a different reply on the same route", () => {
    const evidence = settleSequentialSends();
    const payloads = filterMessagingToolReplyPayload({
      payload: { text: "a genuinely different answer" },
      messageProvider: "slack",
      originatingTo: "channel:c1",
      messagingToolSentTargets: evidence.messagingToolSentTargets ?? [],
      sentTexts: evidence.messagingToolSentTexts ?? [],
    });
    expect(payloads).toHaveLength(1);
  });
});
