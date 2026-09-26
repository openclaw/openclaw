// Feishu tests cover the shared outbound delivery path.
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { sendDurableMessageBatch } from "openclaw/plugin-sdk/channel-outbound";
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

const sendMediaFeishuMock = vi.hoisted(() => vi.fn());
const sendMessageFeishuMock = vi.hoisted(() => vi.fn());
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

type DeliveryQueueRow = {
  status: string;
  recovery_state: string | null;
  platform_send_started_at: number | null;
};

const completionRetention = {
  idPrefix: "feishu-direct-",
  maxAgeMs: 60_000,
  maxEntries: 10,
} as const;

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

describe("Feishu outbound shared delivery", () => {
  beforeEach(() => {
    let textMessageIndex = 0;
    sendMediaFeishuMock.mockReset().mockResolvedValue({
      messageId: "media-1",
      chatId: "chat_1",
    });
    sendMessageFeishuMock.mockReset().mockImplementation(async () => ({
      messageId: `text-${String(++textMessageIndex)}`,
      chatId: "chat_1",
    }));
    sendCardFeishuMock.mockReset().mockResolvedValue({
      messageId: "card-1",
      chatId: "chat_1",
    });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "feishu",
          plugin: createOutboundTestPlugin({ id: "feishu", outbound: feishuOutbound }),
          source: "test",
        },
      ]),
    );
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
    await sendDurableMessageBatch({
      cfg: {},
      channel: "feishu",
      to: "chat_1",
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

    const textChunks = sendMessageFeishuMock.mock.calls.map((call) => {
      const text = (call[0] as { text?: unknown } | undefined)?.text;
      return typeof text === "string" ? text : "";
    });
    const deliveredText = textChunks.join("\n");

    expect(sendCardFeishuMock).not.toHaveBeenCalled();
    expect(sendMediaFeishuMock).toHaveBeenCalledTimes(1);
    expect(sendMediaFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaUrl: "pipeline.png",
        mediaAccess,
        mediaLocalRoots: mediaAccess.localRoots,
        mediaReadFile: readFile,
        to: "chat_1",
      }),
    );
    const sentMedia = sendMediaFeishuMock.mock.calls[0]?.[0] as {
      mediaAccess?: { localRoots?: readonly string[]; readFile?: typeof readFile };
    };
    expect(sentMedia.mediaAccess?.localRoots).toBe(mediaAccess.localRoots);
    expect(sentMedia.mediaAccess?.readFile).toBe(readFile);
    expect(textChunks.length).toBeGreaterThan(1);
    expect(textChunks.every((chunk) => Array.from(chunk).length <= 4000)).toBe(true);
    expect(deliveredText).toContain("account-0-");
    expect(deliveredText).toContain("account-399-");
    expect(deliveredText).toContain(`- ${label}: \`/open-run\``);
  });

  // The card builder owns a table block only on the direct-send actions, which hand it the
  // authored presentation. This path does not: the shared adapter degrades the block to the
  // fallback type this channel advertises and cuts that linear form to the text limit before
  // the plugin renders anything, so what the card carries here is a run of context blocks.
  // The cut is the one a reviewer worries about, so the assertions below are on what the
  // card actually received: every element inside the limit, every row still there, the grey
  // the degraded block asks for, and no pipe row for the cut to break, because the linear
  // form of a table block has none. Projecting the block before adaptation, or advertising a
  // native table this card does not draw, hands the builder plain text blocks and the grey
  // goes, for a one-row table as much as for this one.
  it("splits an oversized table block into context elements the card keeps grey", async () => {
    const rows = 60;
    await sendDurableMessageBatch({
      cfg: {
        channels: {
          feishu: {
            enabled: true,
            markdown: { tables: "code" },
            accounts: { work: { appId: "cli_work", appSecret: "secret_work" } },
          },
        },
      },
      channel: "feishu",
      to: "chat_1",
      skipQueue: true,
      payloads: [
        {
          presentation: {
            blocks: [
              {
                type: "table",
                caption: "Pipeline",
                headers: ["Account", "Stage"],
                rows: Array.from({ length: rows }, (_entry, index) => [
                  `account-${String(index)}-${"x".repeat(80)}`,
                  "Review",
                ]),
              },
            ],
          },
        },
      ],
    });

    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expect(sendCardFeishuMock).toHaveBeenCalledTimes(1);
    const card = (
      sendCardFeishuMock.mock.calls[0]?.[0] as {
        card?: { body?: { elements?: { content?: string }[] } };
      }
    )?.card;
    const elements = (card?.body?.elements ?? []).map((element) => element.content ?? "");
    // Guard the fixture: one element would not exercise the adapter's cut at all.
    expect(elements.length).toBeGreaterThan(1);
    for (const content of elements) {
      expect(content.length).toBeLessThanOrEqual(4000);
      expect(content.startsWith("<font color='grey'>")).toBe(true);
      expect(content.endsWith("</font>")).toBe(true);
    }
    const joined = elements.join("");
    expect(joined).toContain("Pipeline (table)");
    for (let index = 0; index < rows; index += 1) {
      expect(joined).toContain(`account-${String(index)}-`);
    }
    expect(joined).not.toContain("|");
  });

  it("replays a queued direct message after Feishu runtime availability is restored", async () => {
    const originalSendText = feishuChannelRuntime.feishuOutbound.sendText;
    const originalSendFormattedText = feishuChannelRuntime.feishuOutbound.sendFormattedText;
    if (!originalSendText || !originalSendFormattedText) {
      throw new Error("Expected Feishu runtime text senders");
    }
    const deliveryIntentId = "feishu-direct-runtime-availability";

    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "feishu", plugin: feishuPlugin, source: "test" }]),
    );
    // An unavailable runtime takes down every text sender the channel advertises. Leaving
    // one of them resolvable is a runtime that works, and core would route to it.
    feishuChannelRuntime.feishuOutbound.sendText = undefined;
    feishuChannelRuntime.feishuOutbound.sendFormattedText = undefined;

    try {
      await withStateDirEnv("openclaw-feishu-runtime-availability-", async ({ stateDir }) => {
        const initial = await sendDurableMessageBatch({
          cfg: {},
          channel: "feishu",
          to: "chat_1",
          accountId: "default",
          durability: "required",
          deliveryIntentId,
          completionRetention,
          maxRetries: 2,
          payloads: [{ text: "retry after runtime restoration" }],
        });

        expect(initial.status).toBe("failed");
        expect(sendMessageFeishuMock).not.toHaveBeenCalled();
        expect(readDeliveryQueueRow(stateDir, deliveryIntentId)).toMatchObject({
          status: "pending",
          recovery_state: null,
          platform_send_started_at: null,
        });

        feishuChannelRuntime.feishuOutbound.sendText = originalSendText;
        feishuChannelRuntime.feishuOutbound.sendFormattedText = originalSendFormattedText;
        await drainPendingDeliveries({
          drainKey: "feishu:default",
          logLabel: "Feishu runtime availability recovery",
          cfg: {},
          stateDir,
          log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
          selectEntry: (entry) => ({
            match: entry.channel === "feishu",
            bypassBackoff: true,
          }),
        });

        expect(sendMessageFeishuMock).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            to: "chat_1",
            text: "retry after runtime restoration",
          }),
        );
        expect(readDeliveryQueueRow(stateDir, deliveryIntentId)?.status).toBe("completed");
      });
    } finally {
      feishuChannelRuntime.feishuOutbound.sendText = originalSendText;
      feishuChannelRuntime.feishuOutbound.sendFormattedText = originalSendFormattedText;
    }
  });

  it("does not replay a Feishu provider call after dispatch may have begun", async () => {
    const deliveryIntentId = "feishu-direct-ambiguous-provider-result";
    sendMessageFeishuMock.mockRejectedValueOnce(new Error("Feishu provider result was lost"));
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "feishu", plugin: feishuPlugin, source: "test" }]),
    );

    await withStateDirEnv("openclaw-feishu-ambiguous-provider-", async ({ stateDir }) => {
      const initial = await sendDurableMessageBatch({
        cfg: {},
        channel: "feishu",
        to: "chat_1",
        accountId: "default",
        durability: "required",
        deliveryIntentId,
        completionRetention,
        maxRetries: 2,
        payloads: [{ text: "do not replay an ambiguous provider call" }],
      });

      expect(initial.status).toBe("failed");
      expect(sendMessageFeishuMock).toHaveBeenCalledOnce();
      expect(readDeliveryQueueRow(stateDir, deliveryIntentId)).toMatchObject({
        status: "pending",
        recovery_state: "send_attempt_started",
      });
      expect(readDeliveryQueueRow(stateDir, deliveryIntentId)?.platform_send_started_at).toEqual(
        expect.any(Number),
      );

      await drainPendingDeliveries({
        drainKey: "feishu:default",
        logLabel: "Feishu ambiguous provider recovery",
        cfg: {},
        stateDir,
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        selectEntry: (entry) => ({
          match: entry.channel === "feishu",
          bypassBackoff: true,
        }),
      });

      expect(sendMessageFeishuMock).toHaveBeenCalledOnce();
    });
  });
});
