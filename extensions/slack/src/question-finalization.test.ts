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
import { deliverReplies } from "./monitor/replies.js";
import { slackOutbound } from "./outbound-adapter.js";
import { SLACK_QUESTION_FINALIZATION_BLOCKS } from "./reply-action-ids.js";
import { prepareSlackReply } from "./reply-blocks.js";
import { sendMessageSlack, type SlackSendResult } from "./send.js";

function jsonRoundTrip<T>(value: T): T {
  // oxlint-disable-next-line unicorn/prefer-structured-clone -- This test exercises JSON transport.
  return JSON.parse(JSON.stringify(value)) as T;
}

const questionId = "ask_0123456789abcdef0123456789abcdef";
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
const context = (text: string) => ({ type: "context", elements: [{ type: "mrkdwn", text }] });
const button = (actionId: string, value: string, label: string) => ({
  type: "button" as const,
  action_id: actionId,
  text: { type: "plain_text" as const, text: label },
  value,
});
function fallbackClient() {
  const client = createSlackSendTestClient();
  const accepted = {
    questionMessageId: undefined as string | undefined,
    trailingMessageId: undefined as string | undefined,
    questionBlocks: undefined as DisplayBlock[] | undefined,
  };
  let count = 0;
  client.chat.postMessage = vi.fn(async (request: unknown) => {
    const blocks = (request as { blocks?: DisplayBlock[] }).blocks;
    if (blocks?.some((block) => block.type === "data_table")) {
      throw Object.assign(new Error("invalid_blocks"), { data: { error: "invalid_blocks" } });
    }
    const ts = `171234.${String(++count).padStart(3, "0")}`;
    if (hasQuestion(blocks)) {
      accepted.questionMessageId = ts;
      accepted.questionBlocks = blocks;
    } else if (accepted.questionMessageId) {
      accepted.trailingMessageId = ts;
    }
    return { ok: true, channel: "C123", ts };
  });
  return { client, accepted };
}
function expectAcceptedQuestion(accepted: ReturnType<typeof fallbackClient>["accepted"]) {
  expect(accepted.questionMessageId).toBeDefined();
  expect(accepted.trailingMessageId).toBeDefined();
  expect(accepted.trailingMessageId).not.toBe(accepted.questionMessageId);
  expect(hoisted.registration?.deliveryId).toBe(`slack:default:C123:${accepted.questionMessageId}`);
}
function deliverNative(
  payload: ReplyPayload,
  client: ReturnType<typeof createSlackSendTestClient>,
  options: Partial<Parameters<typeof deliverReplies>[0]> = {},
) {
  return deliverReplies({
    cfg,
    replies: [prepareSlackReply(payload)],
    target: "C123",
    token: "xoxb-test",
    runtime: { log: () => {}, error: () => {}, exit: () => {} },
    textLimit: 4000,
    replyToMode: "off",
    eventScope: { teamId: "T123", client, writeClient: client },
    ...options,
  });
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
function fallbackQuestionPayload() {
  return questionPayload(
    [
      { type: "text", text: "Before" },
      { type: "table", caption: "Choices", headers: ["Label"], rows: [["A useful answer"]] },
      questionButtons(),
      { type: "text", text: "Trailing context intentionally arrives after the question card." },
    ],
    { text: "Pick one" },
  );
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
async function deliverGeneric(
  payload: ReplyPayload,
  sendSlack: typeof sendMessageSlack,
  to = "C123",
) {
  const results: OutboundDeliveryResult[] = [];
  await slackOutbound.sendPayload?.({
    cfg,
    to,
    text: payload.text ?? "",
    payload,
    deps: { sendSlack },
    onDeliveryResult: (result) => {
      results.push(result);
    },
  });
  return results;
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

  it("finalizes the accepted native question card before a later delivery observer fails", async () => {
    const { client, accepted } = fallbackClient();
    const update = vi.fn(async () => ({ ok: true }));
    client.chat.update = update;
    const actualSend = await vi.importActual<typeof import("./send.js")>("./send.js");
    hoisted.update.mockImplementation(actualSend.updateMessageSlack);
    const observerError = new Error("delivery observer failed");
    await expect(
      deliverNative(fallbackQuestionPayload(), client, {
        token: "xoxp-authoring-user",
        runtime: {
          log: () => {
            throw observerError;
          },
          error: () => {},
          exit: () => {},
        },
        textLimit: 72,
      }),
    ).rejects.toBe(observerError);

    expectAcceptedQuestion(accepted);
    await hoisted.registration?.finalize("Answered: <!channel>");
    expect(update).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        channel: "C123",
        ts: accepted.questionMessageId,
        text: expect.stringContaining("Answered: &lt;!channel&gt;"),
      }),
    );
  });

  it("matches the current question and preserves unrelated controls in both delivery paths", async () => {
    const foreignQuestionId = "ask_abcdef0123456789abcdef0123456789";
    const callback = button("openclaw:callback_button:1:1", "private-value", "Refresh");
    const foreign = button("openclaw:question_button:2:1", `slq1:${foreignQuestionId}:0`, "Other");
    const current = button("openclaw:question_button:3:1", `slq1:${questionId}:0`, "One");
    const callbackRow = { type: "actions" as const, block_id: "callback", elements: [callback] };
    const foreignRow = { type: "actions" as const, block_id: "foreign", elements: [foreign] };
    const mixedRow = { type: "actions" as const, block_id: "mixed", elements: [current, callback] };

    for (const mode of ["generic", "native"] as const) {
      const deliver = async (blocks: Array<typeof callbackRow>) => {
        hoisted.registration = undefined;
        hoisted.update.mockReset();
        const payload = questionPayload([], {
          channelData: { askUser: { questionId }, slack: { blocks } },
        });
        const client = createSlackSendTestClient();
        if (mode === "native") {
          await deliverNative(payload, client);
        } else {
          const rendered = await render(payload);
          const sendSlack: typeof sendMessageSlack = async (to, text, options) =>
            await sendMessageSlack(to, text, { ...options, client, token: "xoxb-test" });
          await capture(rendered, await deliverGeneric(rendered, sendSlack));
        }
        for (const [post] of client.chat.postMessage.mock.calls) {
          expect(post.text).not.toMatch(/private-value|openclaw:question_|slq1:/u);
        }
      };

      for (const unrelated of [callbackRow, foreignRow]) {
        await deliver([unrelated]);
        expect(hoisted.registration, `${mode}: unrelated control registered`).toBeUndefined();
      }
      await deliver([callbackRow, foreignRow, mixedRow]);
      expect(hoisted.registration, `${mode}: current question missing`).toBeDefined();
      await hoisted.registration?.finalize("Answered: One");
      expect(hoisted.update.mock.calls[0]?.[0]?.blocks).toEqual([
        callbackRow,
        foreignRow,
        { ...mixedRow, elements: [callback] },
        context("Answered: One"),
      ]);
    }
  });

  it("carries the real WebClient question-card identity through upload and chunk progress", async () => {
    const payload = questionPayload(
      [wideTable(), { type: "text", text: "Pick one" }, questionButtons(["One", "Two"])],
      { text: "Pick one", mediaUrl: "https://example.invalid/question-context.png" },
    );
    const rendered = jsonRoundTrip(await render(payload));
    expect(rendered.channelData?.slack).toMatchObject({
      renderedPresentationSegments: [{ kind: "text" }, { kind: "blocks" }],
    });

    const client = createSlackSendTestClient();
    let messageCount = 0;
    client.chat.postMessage = vi.fn(async () => ({
      ok: true,
      ts: `171234.${String(++messageCount).padStart(3, "0")}`,
    }));
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

    const results = await deliverGeneric(rendered, sendSlack, "channel:C123");
    const questionDelivery = results.find((result) => result.meta?.slackQuestionActionIds);
    expect(results.map((result) => result.receipt?.parts[0]?.kind)).toEqual(
      expect.arrayContaining(["media", "text", "card"]),
    );
    expect(questionDelivery?.messageId).not.toBe("F001");

    await capture(
      rendered,
      [
        delivery("another-question", { slackQuestionActionIds: ["openclaw:question_button:9:1"] }),
        ...results,
      ],
      "team:T123:channel:C123",
    );
    expect(hoisted.registration?.deliveryId).toBe(
      `slack:default:C123:${questionDelivery?.messageId}`,
    );
    await hoisted.registration?.finalize("Answered: <!channel>");

    expectUpdate({
      channelId: "C123",
      teamId: "T123",
      messageTs: questionDelivery?.messageId,
      text: expect.stringContaining("Answered: &lt;!channel&gt;"),
      blocks: expect.arrayContaining([context("Answered: &lt;!channel&gt;")]),
    });
    const blocks = hoisted.update.mock.calls[0]?.[0]?.blocks as Array<{ type?: string }>;
    expect(blocks.some((block) => block.type === "actions")).toBe(false);
  });

  it("keeps the actual fallback question card through durable result reconciliation", async () => {
    const payload = fallbackQuestionPayload();
    const plugins = [{ pluginId: "slack", plugin: slackPlugin, source: "test" as const }];
    setActivePluginRegistry(createTestRegistry(plugins));

    const { client, accepted } = fallbackClient();
    const questionSends: Array<{ result: SlackSendResult; progress: SlackSendResult[] }> = [];
    const sendSlack: typeof sendMessageSlack = async (to, text, options) => {
      const progress: SlackSendResult[] = [];
      const sendOptions = {
        ...options,
        cfg,
        token: "xoxb-test",
        client,
        textLimit: 72,
        onDeliveryResult: async (result: SlackSendResult) => {
          progress.push(result);
          await options.onDeliveryResult?.(result);
        },
      };
      // This presentation test uses method mocks rather than the real request boundary.
      delete sendOptions.assertDirectAdapterHandoff;
      const result = await sendMessageSlack(to, text, sendOptions);
      if (result.meta) {
        questionSends.push({ result, progress });
      }
      return result;
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
    expectAcceptedQuestion(accepted);
    expect(questionSends).toHaveLength(1);
    const { result: aggregate, progress } = questionSends[0]!;
    const questionDelivery = progress.find((result) => result.meta);
    expect(progress.length).toBeGreaterThan(1);
    expect(progress.filter((result) => result.meta)).toEqual([
      expect.objectContaining({
        meta: expect.objectContaining({
          slackQuestionActionIds: ["openclaw:question_button:1:1"],
        }),
      }),
    ]);
    expect(
      progress.some((result) => result.receipt.parts[0]?.kind === "card" && !result.meta),
    ).toBe(true);
    expect(aggregate.receipt.parts).toMatchObject(
      progress.map((result, index) => ({
        platformMessageId: result.messageId,
        kind: result.receipt.parts[0]?.kind,
        index,
      })),
    );
    expect(questionDelivery?.messageId).not.toBe(aggregate.messageId);
    expect(jsonRoundTrip(aggregate.meta)).toEqual({
      slackQuestionActionIds: ["openclaw:question_button:1:1"],
      slackQuestionMessageId: questionDelivery?.messageId,
    });
    expect(aggregate.meta?.[SLACK_QUESTION_FINALIZATION_BLOCKS]).toBe(
      questionDelivery?.meta?.[SLACK_QUESTION_FINALIZATION_BLOCKS],
    );
    expect(
      aggregate.meta?.[SLACK_QUESTION_FINALIZATION_BLOCKS]?.some(
        (block) => block.type === "data_table",
      ),
    ).toBe(false);
    expect(batch.results).toHaveLength(1);
    expect(batch.results[0]).toMatchObject({
      messageId: accepted.trailingMessageId,
      meta: {
        slackQuestionActionIds: ["openclaw:question_button:1:1"],
        slackQuestionMessageId: accepted.questionMessageId,
      },
    });
    await hoisted.registration?.finalize("Answered: One");

    expect(hoisted.update).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ channelId: "C123", messageTs: accepted.questionMessageId }),
    );
    expect(hoisted.update.mock.calls[0]?.[0]?.blocks).toEqual([
      ...(accepted.questionBlocks ?? []).filter((block) => block.type !== "actions"),
      context("Answered: One"),
    ]);
    expect(
      client.chat.postMessage.mock.calls.filter(([request]) =>
        hasQuestion((request as { blocks?: DisplayBlock[] }).blocks, "openclaw:question_"),
      ),
    ).toHaveLength(2);
  });
});
