import { createMessageReceiptFromOutboundResults } from "openclaw/plugin-sdk/channel-outbound";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { slackPlugin } from "./channel.js";
import { setSlackRuntime } from "./runtime.js";

const handleSlackActionMock = vi.fn();
const requireRecord = createRequireRecord("record", "expected-label-object");

beforeEach(() => {
  handleSlackActionMock.mockReset();
  setSlackRuntime({
    channel: { slack: { handleSlackAction: handleSlackActionMock } },
  } as never);
});
afterEach(() => setSlackRuntime(null as never));

function requireMockCallArgValue(
  mock: ReturnType<typeof vi.fn>,
  callIndex: number,
  argIndex: number,
): unknown {
  return mock.mock.calls[callIndex]?.[argIndex];
}

function requireMockCallArg(mock: ReturnType<typeof vi.fn>, callIndex: number, argIndex: number) {
  return requireRecord(requireMockCallArgValue(mock, callIndex, argIndex), "mock call argument");
}

describe("Slack message presentation", () => {
  const cfg = { channels: { slack: { botToken: "xoxb-test", appToken: "xapp-test" } } };
  it("keeps data literal and authored mentions and commands intact in mixed presentation edits", async () => {
    handleSlackActionMock.mockResolvedValueOnce({ ok: true });

    await slackPlugin.actions!.handleAction!({
      action: "edit",
      channel: "slack",
      cfg,
      params: {
        channelId: "C123",
        messageId: "1712345678.123456",
        message: "Intentional <!here>",
        presentation: {
          title: "Report <@U0>",
          blocks: [
            { type: "text", text: "Authored <@U1>" },
            {
              type: "chart",
              chartType: "bar",
              title: "Trend <@U2>",
              categories: ["A & B", "<https://example.com>"],
              series: [{ name: "Count <!channel>", values: [0, -2.5] }],
              xLabel: "Period <start>",
              yLabel: "Count > 0",
            },
            {
              type: "chart",
              chartType: "pie",
              title: "Mix &lt;raw&gt;",
              segments: [{ label: "<!here>", value: 1 }],
            },
            {
              type: "table",
              caption: "Table <!channel>",
              headers: ["Owner <name>", "Count"],
              rows: [["<@U3>\n &lt;raw&gt;", 0]],
            },
            { type: "divider" },
            { type: "context", text: "Context <!here>" },
            {
              type: "buttons",
              buttons: [
                {
                  label: "Run <@U4>",
                  action: { type: "command", command: "/say <!channel> & <@U5>" },
                },
                { label: "Open <!here>", url: "https://example.com/?a=1&b=2" },
              ],
            },
            {
              type: "select",
              placeholder: "Owner <!channel>",
              options: [{ label: "<@U6>", value: "private-callback" }],
            },
          ],
        },
      },
    });

    expect(requireMockCallArg(handleSlackActionMock, 0, 0)).toMatchObject({
      action: "editMessage",
      blocks: undefined,
      content: [
        "Intentional <!here>",
        "Report &lt;@U0&gt;",
        "Authored <@U1>",
        "Trend &lt;@U2&gt; (bar chart)\nX axis: Period &lt;start&gt;\nY axis: Count &gt; 0\n- Count &lt;!channel&gt;: A &amp; B: 0; &lt;https://example.com&gt;: -2.5",
        "Mix &amp;lt;raw&amp;gt; (pie chart)\n- &lt;!here&gt;: 1",
        "Table &lt;!channel&gt; (table)\n- Owner &lt;name&gt;: &lt;@U3&gt; &amp;lt;raw&amp;gt;; Count: 0",
        "Context <!here>",
        "- Run &lt;@U4&gt;: `/say <!channel> & <@U5>`\n- Open &lt;!here&gt;: https://example.com/?a=1&amp;b=2",
        "Owner &lt;!channel&gt;:\n- &lt;@U6&gt;",
      ].join("\n\n"),
    });
  });

  it("renders portable presentations through the facade as card receipts (#95440)", async () => {
    const sendSlack = vi.fn().mockResolvedValueOnce({
      messageId: "msg-1",
      channelId: "C123",
      receipt: createMessageReceiptFromOutboundResults({
        results: [{ channel: "slack", messageId: "msg-1", channelId: "C123" }],
        kind: "card",
      }),
    });
    const outbound = slackPlugin.outbound;
    const renderPresentation = outbound?.renderPresentation;
    if (!renderPresentation) {
      throw new Error("Expected Slack presentation renderer");
    }

    const presentation = {
      title: "Status",
      blocks: [{ type: "divider" as const }],
    };
    const payload = { text: "Fallback", presentation };
    const rendered = await renderPresentation({
      payload,
      presentation,
      ctx: { cfg, to: "C123", text: payload.text, payload },
    });
    if (!rendered) {
      throw new Error("Expected rendered Slack presentation payload");
    }
    // Core consumes the portable presentation before handing the native payload to the adapter.
    const { presentation: _presentation, ...deliveryPayload } = rendered;

    const result = await slackPlugin.message!.send!.payload!({
      cfg,
      to: "C123",
      text: deliveryPayload.text ?? "",
      payload: deliveryPayload,
      accountId: "default",
      deps: { sendSlack },
    });

    const to = requireMockCallArgValue(sendSlack, 0, 0);
    const text = requireMockCallArgValue(sendSlack, 0, 1);
    const options = requireMockCallArg(sendSlack, 0, 2);
    expect(to).toBe("C123");
    expect(text).toBe("Fallback\n\nStatus");
    expect(options.blocks).toEqual([
      {
        type: "section",
        text: { type: "mrkdwn", text: "Fallback", verbatim: true },
      },
      {
        type: "header",
        text: { type: "plain_text", text: "Status", emoji: true },
      },
      { type: "divider" },
    ]);
    expect(result.receipt.parts[0]?.kind).toBe("card");
  });
});
