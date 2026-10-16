import { sendDurableMessageBatch } from "openclaw/plugin-sdk/channel-outbound";
import type { OutboundDeliveryResult } from "openclaw/plugin-sdk/channel-send-result";
import {
  createTestRegistry,
  resetGlobalHookRunner,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/channel-test-helpers";
import type { MessagePresentationBlock } from "openclaw/plugin-sdk/interactive-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSlackSendTestClient } from "./blocks.test-helpers.js";

const hoisted = vi.hoisted(() => ({
  update: vi.fn(),
  registration: undefined as
    | { finalize: (statusLine: string) => void | Promise<void>; deliveryId: string }
    | undefined,
}));
vi.mock("openclaw/plugin-sdk/question-gateway-runtime", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("openclaw/plugin-sdk/question-gateway-runtime")>();
  return {
    ...original,
    questionGatewayRuntime: {
      ...original.questionGatewayRuntime,
      registerChannelDelivery: (registration: typeof hoisted.registration) => {
        hoisted.registration = registration;
      },
    },
  };
});
vi.mock("./send.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./send.js")>()),
  updateMessageSlack: hoisted.update,
}));

import { slackPlugin } from "./channel.js";
import { slackOutbound } from "./outbound-adapter.js";
import { SLACK_QUESTION_FINALIZATION_BLOCKS } from "./reply-action-ids.js";
import { sendMessageSlack } from "./send.js";

function jsonRoundTrip<T>(value: T): T {
  // oxlint-disable-next-line unicorn/prefer-structured-clone -- This test exercises JSON transport.
  return JSON.parse(JSON.stringify(value)) as T;
}

const questionId = "ask_0123456789abcdef0123456789abcdef";
const questionActionId = "openclaw:question_button:1:1";
const cfg = { channels: { slack: { botToken: "xoxb-test" } } };
type DisplayBlock = { type?: string; elements?: Array<{ action_id?: string }> };
const hasQuestion = (blocks?: DisplayBlock[], prefix = "openclaw:question_button") =>
  blocks?.some(
    (block) =>
      block.type === "actions" &&
      block.elements?.some((element) => element.action_id?.startsWith(prefix)),
  );
function expectUpdate(fields: Record<string, unknown>) {
  expect(hoisted.update).toHaveBeenCalledWith(expect.objectContaining(fields));
}
const questionButtons = (labels = ["One"]): MessagePresentationBlock => ({
  type: "buttons",
  buttons: labels.map((label) => ({
    label,
    action: { type: "question", questionId, optionValue: label },
  })),
});
function wideTable(): MessagePresentationBlock {
  const headers = Array.from({ length: 21 }, (_, index) => `Column ${index}`);
  return {
    type: "table",
    caption: "Option metadata",
    headers,
    rows: [headers.map((_, index) => `Value ${index}`)],
  };
}
function questionPayload(
  blocks: MessagePresentationBlock[],
  extra: Partial<ReplyPayload> = {},
): ReplyPayload {
  return {
    channelData: { askUser: { questionId, optionValues: ["One", "Two"] } },
    presentation: { blocks },
    ...extra,
  };
}
async function render(payload: ReplyPayload, text = payload.text ?? "") {
  const rendered = await slackOutbound.renderPresentation?.({
    payload,
    presentation: payload.presentation!,
    ctx: { cfg, to: "C123", text, payload },
  });
  if (!rendered) {
    throw new Error("Expected rendered Slack question presentation");
  }
  return rendered;
}
function delivery(
  messageId: string,
  meta?: OutboundDeliveryResult["meta"],
): OutboundDeliveryResult {
  return {
    channel: "slack",
    messageId,
    target: { kind: "channel", id: "C123" },
    ...(meta ? { meta } : {}),
  };
}
function capture(payload: ReplyPayload, results: OutboundDeliveryResult[], to = "C123") {
  return slackOutbound.afterDeliverPayload?.({
    cfg,
    target: { channel: "slack", to, accountId: "default" },
    payload,
    results,
  });
}

describe("Slack question finalization", () => {
  beforeEach(() => {
    hoisted.update.mockReset();
    hoisted.registration = undefined;
  });

  afterEach(() => {
    resetGlobalHookRunner();
    resetPluginRuntimeStateForTest();
  });

  it("removes action blocks and appends terminal context", async () => {
    const payload = questionPayload([
      wideTable(),
      { type: "text", text: "Pick one" },
      questionButtons(["One", "Two"]),
    ]);
    const rendered = await render(payload, "Pick one");
    const renderedAfterTransport = jsonRoundTrip(rendered);
    const renderedSegments = (
      renderedAfterTransport?.channelData?.slack as
        | { renderedPresentationSegments?: unknown[] }
        | undefined
    )?.renderedPresentationSegments;
    expect(renderedSegments?.map((segment) => (segment as { kind?: unknown }).kind)).toEqual([
      "text",
      "blocks",
    ]);
    await capture(
      renderedAfterTransport,
      [
        delivery("44"),
        delivery("another-question", { slackQuestionActionIds: ["openclaw:question_button:9:1"] }),
        delivery("55", {
          slackQuestionActionIds: [questionActionId],
          [SLACK_QUESTION_FINALIZATION_BLOCKS]: [],
        }),
      ],
      "team:T123:channel:C123",
    );

    expect(hoisted.registration?.deliveryId).toBe("slack:default:C123:55");
    await hoisted.registration?.finalize("Answered: <!channel>");
    expectUpdate({
      channelId: "C123",
      teamId: "T123",
      messageTs: "55",
      text: expect.stringContaining("Answered: &lt;!channel&gt;"),
      blocks: expect.arrayContaining([
        {
          type: "context",
          elements: [{ type: "mrkdwn", text: "Answered: &lt;!channel&gt;" }],
        },
      ]),
    });
    const blocks = hoisted.update.mock.calls[0]?.[0]?.blocks as Array<{ type?: string }>;
    expect(blocks.some((block) => block.type === "actions")).toBe(false);
  });

  it("carries the real WebClient question-card identity through upload and chunk progress", async () => {
    const payload = questionPayload([wideTable(), questionButtons()], {
      text: "Pick one",
      mediaUrl: "https://example.invalid/question-context.png",
    });
    const rendered = await render(payload);

    const client = createSlackSendTestClient();
    let messageCount = 0;
    client.chat.postMessage = vi.fn(async () => ({
      ok: true,
      ts: `171234.${String(++messageCount).padStart(3, "0")}`,
    }));
    const results: OutboundDeliveryResult[] = [];
    const sendSlack: typeof sendMessageSlack = async (to, text, options) => {
      if (options.mediaUrl) {
        const upload = {
          messageId: "F001",
          channelId: "C123",
          receipt: {
            platformMessageIds: ["F001"],
            parts: [{ platformMessageId: "F001", kind: "media" as const, index: 0 }],
            sentAt: Date.now(),
          },
        };
        await options.onDeliveryResult?.(upload);
        return upload;
      }
      return await sendMessageSlack(to, text, {
        ...options,
        cfg,
        token: "xoxb-test",
        client,
        textLimit: 32,
      });
    };

    await slackOutbound.sendPayload?.({
      cfg,
      to: "channel:C123",
      text: "Pick one",
      payload: rendered,
      deps: { sendSlack },
      onDeliveryResult: (result) => {
        results.push(result);
      },
    });
    const questionDelivery = results.find((result) => result.meta?.slackQuestionActionIds);
    expect(results.map((result) => result.receipt?.parts[0]?.kind)).toEqual(
      expect.arrayContaining(["media", "text", "card"]),
    );
    expect(questionDelivery?.messageId).not.toBe("F001");

    await capture(rendered, results);
    await hoisted.registration?.finalize("Answered: One");

    expectUpdate({
      channelId: "C123",
      messageTs: questionDelivery?.messageId,
    });
  });

  it("keeps the actual fallback question card through durable result reconciliation", async () => {
    const payload = questionPayload(
      [
        {
          type: "table" as const,
          caption: "Choices",
          headers: ["Label"],
          rows: [["A useful answer"]],
        },
        questionButtons(),
        {
          type: "text" as const,
          text: "Trailing context intentionally arrives after the question card.",
        },
      ],
      { text: "Pick one" },
    );
    const plugins = [{ pluginId: "slack", plugin: slackPlugin, source: "test" as const }];
    setActivePluginRegistry(createTestRegistry(plugins));

    const client = createSlackSendTestClient();
    let messageCount = 0;
    let questionMessageId: string | undefined;
    let acceptedQuestionBlocks: DisplayBlock[] | undefined;
    let trailingMessageId: string | undefined;
    client.chat.postMessage = vi.fn(async (request: unknown) => {
      const blocks = (request as { blocks?: DisplayBlock[] }).blocks;
      if (blocks?.some((block) => block.type === "data_table")) {
        throw Object.assign(new Error("invalid_blocks"), { data: { error: "invalid_blocks" } });
      }
      const ts = `171234.${String(++messageCount).padStart(3, "0")}`;
      if (hasQuestion(blocks)) {
        questionMessageId = ts;
        acceptedQuestionBlocks = blocks;
      } else if (questionMessageId) {
        trailingMessageId = ts;
      }
      return { ok: true, channel: "C123", ts };
    });
    const sendSlack: typeof sendMessageSlack = async (to, text, options) => {
      const sendOptions = {
        ...options,
        cfg,
        token: "xoxb-test",
        client,
        textLimit: 72,
      };
      // This presentation test uses method mocks rather than the real request boundary.
      delete sendOptions.assertDirectAdapterHandoff;
      return await sendMessageSlack(to, text, sendOptions);
    };

    const batch = await sendDurableMessageBatch({
      cfg,
      channel: "slack",
      to: "C123",
      accountId: "default",
      payloads: [payload],
      deps: { sendSlack },
    });

    if (batch.status !== "sent") {
      throw batch.status === "failed"
        ? batch.error
        : new Error("Expected the Slack question fallback to be delivered");
    }
    expect(questionMessageId).toBeDefined();
    expect(trailingMessageId).toBeDefined();
    expect(trailingMessageId).not.toBe(questionMessageId);
    expect(batch.results).toHaveLength(1);
    expect(batch.results[0]).toMatchObject({
      messageId: trailingMessageId,
      meta: {
        slackQuestionActionIds: ["openclaw:question_button:1:1"],
        slackQuestionMessageId: questionMessageId,
      },
    });
    expect(hoisted.registration?.deliveryId).toBe(`slack:default:C123:${questionMessageId}`);

    await hoisted.registration?.finalize("Answered: One");

    expect(hoisted.update).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ channelId: "C123", messageTs: questionMessageId }),
    );
    expect(hoisted.update.mock.calls[0]?.[0]?.blocks).toEqual([
      ...(acceptedQuestionBlocks ?? []).filter((block) => block.type !== "actions"),
      { type: "context", elements: [{ type: "mrkdwn", text: "Answered: One" }] },
    ]);
    expect(
      client.chat.postMessage.mock.calls.filter(([request]) =>
        hasQuestion((request as { blocks?: DisplayBlock[] }).blocks, "openclaw:question_"),
      ),
    ).toHaveLength(2);
  });
});
