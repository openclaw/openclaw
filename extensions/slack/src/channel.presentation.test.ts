import { createMessageReceiptFromOutboundResults } from "openclaw/plugin-sdk/channel-outbound";
import { assert, expect, it, vi } from "vitest";
import { createSlackActions } from "./channel-actions.js";
import { slackPlugin } from "./channel.js";

const cfg = { channels: { slack: { botToken: "xoxb-test", appToken: "xapp-test" } } };
it("keeps data literal and authored mentions intact in mixed presentation edits", async () => {
  const invoke = vi.fn(async (_action: Record<string, unknown>) => ({
    content: [],
    details: { ok: true },
  }));

  await createSlackActions("slack", { invoke }).handleAction!({
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
            type: "table",
            caption: "Table <!channel>",
            headers: ["Owner <name>", "Count"],
            rows: [["<@U3>\n &lt;raw&gt;", 0]],
          },
          { type: "context", text: "Context <!here>" },
        ],
      },
    },
  });

  expect(invoke.mock.calls[0]?.[0]).toMatchObject({
    action: "editMessage",
    blocks: undefined,
    content: [
      "Intentional <!here>",
      "Report &lt;@U0&gt;",
      "Authored <@U1>",
      "Trend &lt;@U2&gt; (bar chart)\nX axis: Period &lt;start&gt;\nY axis: Count &gt; 0\n- Count &lt;!channel&gt;: A &amp; B: 0; &lt;https://example.com&gt;: -2.5",
      "Table &lt;!channel&gt; (table)\n- Owner &lt;name&gt;: &lt;@U3&gt; &amp;lt;raw&amp;gt;; Count: 0",
      "Context <!here>",
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
  const presentation = {
    title: "Status",
    blocks: [{ type: "divider" as const }],
  };
  const payload = { text: "Fallback", presentation };
  const rendered = await slackPlugin.outbound!.renderPresentation!({
    payload,
    presentation,
    ctx: { cfg, to: "C123", text: payload.text, payload },
  });
  assert(rendered, "Expected rendered Slack presentation payload");
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

  expect(sendSlack.mock.calls[0]?.slice(0, 2)).toEqual(["C123", "Fallback\n\nStatus"]);
  expect(result.receipt.parts[0]?.kind).toBe("card");
});
