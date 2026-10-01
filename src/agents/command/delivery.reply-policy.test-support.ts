// Registered with the existing delivery fixture; no additional runtime boot.
import { expect, it, type Mock } from "vitest";
import {
  markReplyPayloadForSourceSuppressionDelivery,
  type ReplyPayload,
} from "../../auto-reply/reply-payload.js";
import type { deliverOutboundPayloads } from "../../infra/outbound/deliver.js";
import { hasVisibleAgentPayload } from "../embedded-agent-runner/message-visibility.js";
import type { AgentCommandDeliveryResult } from "./delivery-result.js";
import type { AgentCommandOpts } from "./types.js";

export function registerAgentCommandReplyPolicyTests({
  deliverAgentCommandResultForTest,
  deliverOutboundPayloadsMock,
  latestOutboundDeliveryArgs,
  expectDeliveryStatusFields,
}: {
  deliverAgentCommandResultForTest: (params: {
    payloads: ReplyPayload[];
    opts?: Partial<AgentCommandOpts>;
    omitReplyTarget?: boolean;
  }) => Promise<AgentCommandDeliveryResult>;
  deliverOutboundPayloadsMock: Mock<typeof deliverOutboundPayloads>;
  latestOutboundDeliveryArgs: () => { payloads: ReplyPayload[] };
  expectDeliveryStatusFields: (
    delivered: AgentCommandDeliveryResult,
    expected: Record<string, unknown>,
  ) => unknown;
}) {
  it.each([
    {
      name: "only a tool failure",
      payloads: [{ text: "Yield failed", isError: true }],
      visible: false,
    },
    {
      name: "a final reply after a tool failure",
      payloads: [
        { text: "Yield failed", isError: true },
        { text: "Both child results are ready." },
      ],
      visible: true,
    },
  ])("preserves completion visibility for $name", async ({ payloads, visible }) => {
    const delivered = await deliverAgentCommandResultForTest({
      payloads,
      opts: { deliver: false },
      omitReplyTarget: true,
    });
    expect(
      hasVisibleAgentPayload(delivered, {
        includeErrorPayloads: false,
        includeReasoningPayloads: false,
        requireTerminalContent: true,
      }),
    ).toBe(visible);
  });

  it.each([
    { name: "plain final", text: "Private answer", reason: "message_tool_only" },
    { name: "intentional silence", text: "NO_REPLY", reason: "no_visible_payload" },
    { name: "empty final", text: "", reason: "no_visible_payload" },
  ])("enforces tool-only delivery without losing $name evidence", async ({ text, reason }) => {
    const delivered = await deliverAgentCommandResultForTest({
      payloads: [{ text }],
      opts: { sourceReplyDeliveryMode: "message_tool_only" },
    });
    expect(deliverOutboundPayloadsMock).not.toHaveBeenCalled();
    expectDeliveryStatusFields(delivered, {
      requested: true,
      attempted: false,
      status: "suppressed",
      succeeded: true,
      reason,
      resultCount: 0,
    });
    expect(delivered.payloads).toMatchObject(reason === "message_tool_only" ? [{ text }] : []);
  });

  it("delivers only host-authorized payloads from a mixed tool-only final", async () => {
    deliverOutboundPayloadsMock.mockResolvedValue([{ channel: "slack", messageId: "diagnostic" }]);
    const delivered = await deliverAgentCommandResultForTest({
      payloads: [
        { text: "Private ordinary answer" },
        markReplyPayloadForSourceSuppressionDelivery({
          text: "Sign in to continue",
          isError: true,
        }),
      ],
      opts: { sourceReplyDeliveryMode: "message_tool_only" },
    });
    expect(latestOutboundDeliveryArgs().payloads).toEqual([
      expect.objectContaining({ text: "Sign in to continue" }),
    ]);
    expectDeliveryStatusFields(delivered, { status: "sent", resultCount: 1 });
  });
}
