// `pendingMessagingCalls` is the third holder of a post-budget tool start's
// decoded arguments: the event consumer's `toolArgsByCallId`, the tracking's
// `activeCliTools`, and this one. It is capped at 64 entries and each entry can
// carry a near-8-MiB payload, so it survived the byte cap the other two got.
//
// These drive the production consumer pair — real `createCliEventHandlers` over
// a real `createCliToolTracking` — because the bound is a property of how the
// two agree, not of either one alone. The last test is the control: it passes on
// the unbounded tree too.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.js";
import { buildPreparedCliRunContext } from "../cli-runner.test-helpers.js";
import {
  MAX_REDUCED_MESSAGING_ARG_CHARS,
  MAX_RETAINED_TOOL_ARG_CHARS,
} from "./execute-event-retention.js";
import { createCliEventHandlers } from "./execute-events.js";
import { createCliToolTracking } from "./execute-tool-tracking.js";
import type { PreparedCliRunContext } from "./types.js";

type MessagingParams = {
  sourceReplyDeliveryMode?: string;
  messageChannel?: string;
  currentThreadTs?: string;
  config?: OpenClawConfig;
};

function buildRuntime(overrides: MessagingParams = {}) {
  const context = buildPreparedCliRunContext({
    runId: "messaging-retention",
    sessionKey: "agent:main:slack:channel:c1",
  });
  Object.assign(context.params as MessagingParams, overrides);
  const toolTracking = createCliToolTracking(context as PreparedCliRunContext);
  const handlers = createCliEventHandlers({
    context: context as PreparedCliRunContext,
    toolTracking,
    getRunState: () => ({ failed: false, error: undefined }),
  });
  return { context, toolTracking, handlers };
}

/** A visible `message` send, the shape the CLI emits it in. */
function startSend(
  handlers: ReturnType<typeof createCliEventHandlers>,
  toolCallId: string,
  args: Record<string, unknown>,
): void {
  handlers.emitParsedToolUseStart({
    toolCallId,
    name: "mcp__openclaw__message",
    kind: "mcp_tool_use",
    args,
  });
}

function settledSendResult(): unknown {
  return {
    details: {
      messageDelivery: {
        status: "settled",
        partialDelivery: false,
        createdThreadIds: [],
        sourceReplyDelivered: true,
      },
    },
  };
}

function finishSend(handlers: ReturnType<typeof createCliEventHandlers>, toolCallId: string): void {
  handlers.emitParsedToolResult({
    toolCallId,
    name: "mcp__openclaw__message",
    isError: false,
    result: settledSendResult(),
  });
}

// 2 MiB per send, five sends outstanding: 10 MiB against an 8 MiB bound, with
// the 64-entry count cap far out of reach so it cannot be what holds.
const SEND_CHARS = 2 * 1024 * 1024;
const SENDS = 5;

function sendBody(index: number): string {
  return `${index}:${"x".repeat(SEND_CHARS)}`;
}

describe("CLI delivery-evidence retention bounds", () => {
  it("releases the delivery-evidence payload the run's retention refused", () => {
    const { toolTracking, handlers } = buildRuntime();
    for (let index = 0; index < SENDS; index += 1) {
      startSend(handlers, `send-${index}`, {
        action: "send",
        channel: "slack",
        target: "c1",
        content: sendBody(index),
      });
    }
    expect(SEND_CHARS * SENDS).toBeGreaterThan(MAX_RETAINED_TOOL_ARG_CHARS);

    // Behavioral first, so an unbounded build fails on an observation rather
    // than on a missing accessor: the first send still echoes its real content
    // as delivery evidence, a send past the bound echoes none.
    finishSend(handlers, "send-0");
    finishSend(handlers, `send-${SENDS - 1}`);
    const evidence = toolTracking.withExecutionEvidence({ text: "" });
    expect(evidence.messagingToolSentTexts).toContain(sendBody(0));
    expect(evidence.messagingToolSentTexts).not.toContain(sendBody(SENDS - 1));

    const retained = handlers.getRetainedStateSizes();
    expect(retained.reducedMessagingCalls).toBeGreaterThan(0);
    expect(retained.retainedToolArgChars).toBeLessThanOrEqual(MAX_RETAINED_TOOL_ARG_CHARS);
  });

  it("still settles delivery and the source reply for a send past the bound", () => {
    const { toolTracking, handlers } = buildRuntime();
    for (let index = 0; index < SENDS; index += 1) {
      startSend(handlers, `send-${index}`, {
        action: "send",
        channel: "slack",
        target: "c1",
        content: sendBody(index),
      });
    }
    // Only the send whose arguments were refused: whatever settles here settles
    // from the facts the bounded holder kept, not from the payload.
    finishSend(handlers, `send-${SENDS - 1}`);
    const evidence = toolTracking.withExecutionEvidence({ text: "" });
    expect(evidence.didSendViaMessagingTool).toBe(true);
    expect(evidence.didDeliverSourceReplyViaMessageTool).toBe(true);
    expect(evidence.sourceReplyDelivered).toBe(true);
    expect(evidence.messagingToolSentTargets?.[0]).toMatchObject({ provider: "slack" });
  });

  it("fails closed when a reduced send is still unresolved at exit", async () => {
    // Routeless sends under `message_tool_only` are the case that classifies as
    // the private internal sink — and that classification is exactly the proof a
    // reduced entry can no longer make, because the arguments it would read are
    // the ones that were released.
    const { toolTracking, handlers } = buildRuntime({
      sourceReplyDeliveryMode: "message_tool_only",
      messageChannel: "slack",
      currentThreadTs: "1700000000.000100",
      config: {} as OpenClawConfig,
    });
    for (let index = 0; index < SENDS; index += 1) {
      startSend(handlers, `send-${index}`, { action: "send", content: sendBody(index) });
    }
    const errors: unknown[] = [];
    await toolTracking.finishDeliveryTracking({
      useManagedClaudeLiveSession: false,
      recordRunError: (error) => errors.push(error),
    });
    expect(
      errors.map((error) => (error instanceof Error ? error.message : String(error))),
    ).toContain("CLI JSONL message tool call remained unresolved after exit");
    // The conservative direction: a turn that fails after this must not deliver
    // the same message a second time.
    expect(toolTracking.withExecutionEvidence({ text: "" }).didSendViaMessagingTool).toBe(true);
  });

  // Individually tiny provider fields, enough of them to fill the reduced
  // allowance to within a few characters, so a 15-character `{"final":false}`
  // charged after them cannot fit. Where `final` sits in the decoded object must
  // not decide whether it survives: an absent flag reads as `final: true`.
  const SMALL_FIELDS = 1_000;
  function smallFields(): Record<string, unknown> {
    return Object.fromEntries(
      Array.from({ length: SMALL_FIELDS }, (_, index) => [`p${index}`, "x"]),
    );
  }
  it.each([
    { order: "before the small fields", finalFirst: true },
    { order: "after the small fields", finalFirst: false },
  ])("keeps a reduced send's final:false $order at the aggregate bound", ({ finalFirst }) => {
    const { toolTracking, handlers } = buildRuntime();
    for (let index = 0; index < SENDS - 1; index += 1) {
      startSend(handlers, `send-${index}`, {
        action: "send",
        channel: "slack",
        target: "c1",
        content: sendBody(index),
      });
    }
    const routing = { action: "send", channel: "slack", target: "c1" };
    const args = finalFirst
      ? { final: false, ...routing, content: sendBody(SENDS - 1), ...smallFields() }
      : { ...routing, content: sendBody(SENDS - 1), ...smallFields(), final: false };
    // The fixture really is past both bounds: the run's retention refuses this
    // send, and its small fields alone outgrow the reduced allowance.
    expect(JSON.stringify(smallFields()).length).toBeGreaterThan(MAX_REDUCED_MESSAGING_ARG_CHARS);
    startSend(handlers, `send-${SENDS - 1}`, args);
    expect(handlers.getRetainedStateSizes().reducedMessagingCalls).toBeGreaterThan(0);

    handlers.emitParsedToolResult({
      toolCallId: `send-${SENDS - 1}`,
      name: "mcp__openclaw__message",
      isError: false,
      result: {
        details: {
          ...(settledSendResult() as { details: Record<string, unknown> }).details,
          sourceReplySink: "internal-ui",
          deliveryStatus: "sent",
          sourceReply: { text: "progress update" },
        },
      },
    });
    const evidence = toolTracking.withExecutionEvidence({ text: "" });
    expect(evidence.didDeliverSourceReplyViaMessageTool).toBe(true);
    // A progress send stays a progress send: recording it as the final reply
    // would suppress the reply the turn still owes.
    expect(evidence.messagingToolSourceReplyPayloads).toEqual([
      { text: "progress update", sourceReplyFinal: false },
    ]);
    expect(evidence.messagingToolSentTargets?.[0]).toMatchObject({
      provider: "slack",
      sourceReplyFinal: false,
    });
  });

  it("does not touch a send that stays well inside every bound", () => {
    // Control: this passes on the unbounded tree too.
    const { toolTracking, handlers } = buildRuntime();
    startSend(handlers, "send-small", {
      action: "send",
      channel: "slack",
      target: "c1",
      content: "hello",
    });
    finishSend(handlers, "send-small");
    const evidence = toolTracking.withExecutionEvidence({ text: "" });
    expect(evidence.didSendViaMessagingTool).toBe(true);
    expect(evidence.messagingToolSentTexts).toEqual(["hello"]);
    expect(handlers.getRetainedStateSizes().reducedMessagingCalls ?? 0).toBe(0);
  });
});
