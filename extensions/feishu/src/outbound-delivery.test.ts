import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  deliverInboundReplyWithMessageSendContext,
  deriveDurableFinalDeliveryRequirements,
  sendDurableMessageBatch,
} from "openclaw/plugin-sdk/channel-outbound";
import {
  createOutboundTestPlugin,
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  resetGlobalHookRunner,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { drainPendingDeliveries } from "openclaw/plugin-sdk/delivery-queue-runtime";
import { withStateDirEnv } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendMediaFeishuMock = vi.hoisted(() => vi.fn<typeof import("./media.js").sendMediaFeishu>());
const sendMessageFeishuMock = vi.hoisted(() =>
  vi.fn<typeof import("./send.js").sendMessageFeishu>(),
);
const sendCardFeishuMock = vi.hoisted(() => vi.fn());

vi.mock("./media.js", () => ({
  sendStickerFeishu: vi.fn(),
  sendMediaFeishu: sendMediaFeishuMock,
  shouldSuppressFeishuTextForVoiceMedia: () => false,
}));

vi.mock("./send.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./send.js")>()),
  editMessageFeishu: vi.fn(),
  getMessageFeishu: vi.fn(),
  sendCardFeishu: sendCardFeishuMock,
  sendMessageFeishu: sendMessageFeishuMock,
  sendStructuredCardFeishu: vi.fn(),
}));

import { feishuPlugin } from "./channel.js";
import { feishuChannelRuntime } from "./channel.runtime.js";
import { feishuOutbound } from "./outbound.js";
import { toFeishuSendResult } from "./send-result.js";

type DeliveryQueueRow = {
  status: string;
  recovery_state: string | null;
  platform_send_started_at: number | null;
};

function readDeliveryQueueRow(stateDir: string, id: string): DeliveryQueueRow | undefined {
  const database = new DatabaseSync(path.join(stateDir, "state", "openclaw.sqlite"), {
    readOnly: true,
  });
  try {
    return database
      .prepare(
        `SELECT status, recovery_state, platform_send_started_at
           FROM delivery_queue_entries
          WHERE queue_name = 'outbound-prepared-v1' AND id = ?`,
      )
      .get(id) as DeliveryQueueRow | undefined;
  } finally {
    database.close();
  }
}

const sendBatch = (
  options: Omit<Parameters<typeof sendDurableMessageBatch>[0], "cfg" | "channel" | "to">,
) => sendDurableMessageBatch({ cfg: {}, channel: "feishu", to: "chat_1", ...options });
const sendResult = (messageId: string, kind: "text" | "media") =>
  toFeishuSendResult({ data: { message_id: messageId } }, "chat_1", kind);

describe("Feishu outbound shared delivery", () => {
  beforeEach(() => {
    let textMessageIndex = 0;
    sendMediaFeishuMock.mockReset().mockResolvedValue(sendResult("media-1", "media"));
    sendMessageFeishuMock
      .mockReset()
      .mockImplementation(async () => sendResult(`text-${String(++textMessageIndex)}`, "text"));
    sendCardFeishuMock.mockReset().mockResolvedValue({ messageId: "card-1", chatId: "chat_1" });
    const plugin = createOutboundTestPlugin({ id: "feishu", outbound: feishuOutbound });
    setActivePluginRegistry(createTestRegistry([{ pluginId: "feishu", plugin, source: "test" }]));
    resetGlobalHookRunner();
  });

  afterEach(() => {
    resetGlobalHookRunner();
    resetPluginRuntimeStateForTest();
  });

  it("routes oversized presentation media through one media send and chunked fallback text", async () => {
    const label = "Open the complete retained workflow run details";
    const readFile = vi.fn(async () => Buffer.from("approved image"));
    const mediaAccess = {
      localRoots: ["/approved/workspace"],
      workspaceDir: "/approved/workspace",
      readFile,
    };
    await sendBatch({
      skipQueue: true,
      mediaAccess,
      payloads: [
        {
          mediaUrl: "pipeline.png",
          presentation: {
            blocks: [
              {
                type: "table",
                caption: "Large pipeline",
                headers: ["Account", "Stage"],
                rows: Array.from({ length: 400 }, (_entry, index) => [
                  `account-${String(index)}-${"x".repeat(80)}`,
                  "Review",
                ]),
              },
              {
                type: "buttons",
                buttons: [{ label, action: { type: "command", command: "/open-run" } }],
              },
            ],
          },
        },
      ],
    });

    const textChunks = sendMessageFeishuMock.mock.calls.map(([params]) => params.text);
    const deliveredText = textChunks.join("\n");

    expect(sendCardFeishuMock).not.toHaveBeenCalled();
    expect(sendMediaFeishuMock).toHaveBeenCalledTimes(1);
    const sentMedia = sendMediaFeishuMock.mock.calls[0]?.[0];
    expect(sentMedia).toMatchObject({
      mediaUrl: "pipeline.png",
      mediaAccess,
      mediaLocalRoots: mediaAccess.localRoots,
      mediaReadFile: readFile,
      to: "chat_1",
    });
    expect(sentMedia?.mediaAccess?.localRoots).toBe(mediaAccess.localRoots);
    expect(sentMedia?.mediaAccess?.readFile).toBe(readFile);
    expect(textChunks.length).toBeGreaterThan(1);
    expect(textChunks.every((chunk) => Array.from(chunk).length <= 4000)).toBe(true);
    expect(deliveredText).toContain("account-0-");
    expect(deliveredText).toContain("account-399-");
    expect(deliveredText).toContain(`- ${label}: \`/open-run\``);
  });

  it.each(["reply", "thread", "card"] as const)(
    "delivers a durable final with %s context",
    async (route) => {
      setActivePluginRegistry(
        createTestRegistry([{ pluginId: "feishu", plugin: feishuPlugin, source: "test" }]),
      );
      await withStateDirEnv("openclaw-feishu-final-", async () => {
        const payload = {
          text: "Final answer",
          ...(route === "thread" ? { mediaUrl: "https://example.com/image.png" } : {}),
          ...(route === "card"
            ? { presentation: { blocks: [{ type: "text" as const, text: "Card answer" }] } }
            : {}),
        };
        const replyToId = route === "thread" ? undefined : "om_parent";
        const threadId = route === "thread" ? "om_topic" : undefined;
        const result = await deliverInboundReplyWithMessageSendContext({
          cfg: {},
          channel: "feishu",
          accountId: "default",
          agentId: "main",
          ctxPayload: {
            CommandAuthorized: true,
            CommandTurn: { kind: "normal", source: "message", authorized: false },
            OriginatingTo: "chat_1",
          },
          info: { kind: "final" },
          payload,
          replyToId,
          threadId,
          requiredCapabilities: deriveDurableFinalDeliveryRequirements({
            payload,
            replyToId,
            threadId,
            payloadTransport: route === "card",
          }),
        });
        expect(result.status).toBe("handled_visible");
        const transport =
          route === "card"
            ? sendCardFeishuMock
            : route === "thread"
              ? sendMediaFeishuMock
              : sendMessageFeishuMock;
        expect(transport).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            to: "chat_1",
            replyToMessageId: route === "thread" ? "om_topic" : "om_parent",
            replyInThread: route === "thread",
          }),
        );
      });
    },
  );

  it.each(
    [
      { phase: "runtime unavailability", started: false },
      { phase: "an ambiguous provider result", started: true },
    ].flatMap(({ phase, started }) =>
      (["text", "payload"] as const).map((kind) => ({ phase, started, kind })),
    ),
  )("recovers queued $kind after $phase without duplicate dispatch", async ({ started, kind }) => {
    const originalSenders = {
      sendText: feishuChannelRuntime.feishuOutbound.sendText,
      sendPayload: feishuChannelRuntime.feishuOutbound.sendPayload,
    };
    const method = kind === "payload" ? "sendPayload" : "sendText";
    const transport = kind === "payload" ? sendCardFeishuMock : sendMessageFeishuMock;
    const deliveryIntentId = `feishu-direct-${kind}-${started ? "ambiguous" : "unavailable"}`;
    if (started) {
      transport.mockRejectedValueOnce(new Error("Feishu provider result was lost"));
    }
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "feishu", plugin: feishuPlugin, source: "test" }]),
    );
    if (!started) {
      feishuChannelRuntime.feishuOutbound[method] = undefined;
    }

    try {
      await withStateDirEnv("openclaw-feishu-recovery-", async ({ stateDir }) => {
        const initial = await sendBatch({
          accountId: "default",
          durability: "required",
          deliveryIntentId,
          completionRetention: { idPrefix: "feishu-direct-", maxAgeMs: 60_000, maxEntries: 10 },
          maxRetries: 2,
          replyToId: "om_parent",
          payloads: [
            {
              text: "queued reply",
              ...(kind === "payload"
                ? { presentation: { blocks: [{ type: "text" as const, text: "queued card" }] } }
                : {}),
            },
          ],
        });
        expect(initial.status).toBe("failed");
        expect(transport).toHaveBeenCalledTimes(started ? 1 : 0);
        expect(readDeliveryQueueRow(stateDir, deliveryIntentId)).toMatchObject({
          status: "pending",
          recovery_state: started ? "send_attempt_started" : null,
          platform_send_started_at: started ? expect.any(Number) : null,
        });

        Object.assign(feishuChannelRuntime.feishuOutbound, originalSenders);
        await drainPendingDeliveries({
          drainKey: "feishu:default",
          logLabel: "Feishu delivery recovery",
          cfg: {},
          stateDir,
          log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
          selectEntry: (entry) => ({ match: entry.channel === "feishu", bypassBackoff: true }),
        });
        expect(transport).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ to: "chat_1", replyToMessageId: "om_parent" }),
        );
        if (!started) {
          expect(readDeliveryQueueRow(stateDir, deliveryIntentId)?.status).toBe("completed");
        }
      });
    } finally {
      Object.assign(feishuChannelRuntime.feishuOutbound, originalSenders);
    }
  });
});
