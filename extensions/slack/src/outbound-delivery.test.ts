// Slack tests cover outbound delivery plugin behavior.
import { sendDurableMessageBatch } from "openclaw/plugin-sdk/channel-outbound";
import {
  addTestHook,
  createEmptyPluginRegistry,
  createOutboundTestPlugin,
  createTestRegistry,
  initializeGlobalHookRunner,
  resetPluginRuntimeStateForTest,
  resetGlobalHookRunner,
  setActivePluginRegistry,
  type PluginHookRegistration,
} from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import * as clientDelivery from "./client-delivery.js";
import { createSlackWriteClient } from "./client.js";
import { slackOutbound } from "./outbound-adapter.js";
import { sendMessageSlack } from "./send.js";
import { clearSlackThreadParticipationCache } from "./sent-thread-cache.js";

const sendMessageSlackMock = vi.hoisted(() => vi.fn());

vi.mock("./send.runtime.js", () => ({
  sendMessageSlack: sendMessageSlackMock,
}));

type ScriptedSlackResponse = { ok: true; ts: string } | { ok: false; error: "invalid_blocks" };

function createScriptedSlackWriteClient(responses: readonly ScriptedSlackResponse[]) {
  const remaining = [...responses];
  const requestBodies: URLSearchParams[] = [];
  const client = createSlackWriteClient("xoxb-test", {
    fetch: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.href !== "https://slack.com/api/chat.postMessage") {
        throw new Error(`Unexpected Slack API endpoint: ${url.href}`);
      }
      const response = remaining.shift();
      if (!response) {
        throw new Error("Slack API response sequence exhausted");
      }
      const body = init?.body;
      assert(typeof body === "string", "Expected URL-encoded Slack request body");
      requestBodies.push(new URLSearchParams(body));
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  return {
    client,
    requestBodies,
    assertExhausted: () => expect(remaining).toHaveLength(0),
  };
}

function decodeSlackBlocks(body: URLSearchParams): unknown {
  const encoded = body.get("blocks");
  assert(encoded, "Slack request blocks missing");
  return JSON.parse(encoded);
}

const cfg: OpenClawConfig = {
  channels: {
    slack: {
      botToken: "xoxb-test",
      appToken: "xapp-test",
      accounts: {
        default: {
          botToken: "xoxb-default",
          appToken: "xapp-default",
        },
      },
    },
  },
};

describe("slack outbound shared hook wiring", () => {
  beforeEach(() => {
    sendMessageSlackMock.mockReset();
    sendMessageSlackMock.mockResolvedValue({ messageId: "m1", channelId: "C123" });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "slack",
          plugin: createOutboundTestPlugin({ id: "slack", outbound: slackOutbound }),
          source: "test",
        },
      ]),
    );
    resetGlobalHookRunner();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearSlackThreadParticipationCache();
    resetGlobalHookRunner();
    resetPluginRuntimeStateForTest();
  });

  describe.each([
    {
      name: "raw blocks",
      content: { channelData: { slack: { blocks: [{ type: "divider" }] } } },
      expectedText: "Caption",
      hasBlocks: true,
    },
    {
      name: "oversized presentation fallback",
      content: { text: undefined, presentation: { title: "x".repeat(151), blocks: [] } },
      expectedText: "x".repeat(151),
      hasBlocks: false,
    },
  ])("media followed by $name", ({ content, expectedText, hasBlocks }) => {
    it.each([
      { name: "mediaUrl", media: { mediaUrl: "https://example.com/a.png" } },
      { name: "singleton mediaUrls", media: { mediaUrls: ["https://example.com/a.png"] } },
      {
        name: "mediaUrls list",
        media: { mediaUrls: ["https://example.com/a.png", "https://example.com/b.png"] },
      },
    ])("uploads $name only once before finalization", async ({ media }) => {
      const mediaUrls = media.mediaUrls ?? [media.mediaUrl];
      const postedBodies: string[] = [];
      const client = createSlackWriteClient("xoxb-test", {
        fetch: async (_input, init) => {
          const body = init?.body;
          assert(typeof body === "string", "Expected URL-encoded Slack request body");
          postedBodies.push(body);
          return new Response(JSON.stringify({ ok: true, ts: "171234.567" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      });
      const upload = vi
        .spyOn(clientDelivery, "uploadSlackFile")
        .mockImplementation(async (opts) => {
          await opts.onPlatformSendDispatch?.();
          return `F${mediaUrls.indexOf(opts.mediaUrl) + 1}`;
        });
      sendMessageSlackMock.mockImplementation(
        async (to: string, text: string, opts: Parameters<typeof sendMessageSlack>[2]) =>
          await sendMessageSlack(to, text, { ...opts, client }),
      );
      const payload: ReplyPayload = { text: "Caption", ...media, ...content };

      const result = await sendDurableMessageBatch({
        cfg,
        channel: "slack",
        to: "C123",
        payloads: [payload],
        accountId: "default",
        replyToId: "1712000000.000001",
      });

      expect(upload.mock.calls.map(([opts]) => opts.mediaUrl)).toEqual(mediaUrls);
      assert(result.status === "sent", "error" in result ? String(result.error) : result.status);
      expect(sendMessageSlackMock).toHaveBeenCalledTimes(mediaUrls.length + 1);
      const finalOptions = sendMessageSlackMock.mock.calls.at(-1)?.[2];
      expect(finalOptions).not.toHaveProperty("mediaUrl");
      expect(Boolean(finalOptions.blocks)).toBe(hasBlocks);
      expect(postedBodies).toHaveLength(1);
      const postPayload = new URLSearchParams(postedBodies[0]);
      expect(postPayload.get("text")).toBe(expectedText);
      expect(postPayload.get("thread_ts")).toBe("1712000000.000001");
      expect(upload.mock.calls.every(([opts]) => opts.threadTs === "1712000000.000001")).toBe(true);
      expect(result.results[0]?.receipt?.parts.map((part) => part.platformMessageId)).toEqual([
        ...mediaUrls.map((_url, index) => `F${index + 1}`),
        "171234.567",
      ]);
    });
  });

  it("delivers a valid field-rich section through the outbound adapter", async () => {
    const transport = createScriptedSlackWriteClient([{ ok: true, ts: "171234.567" }]);
    sendMessageSlackMock.mockImplementation(
      async (to: string, text: string, opts: Parameters<typeof sendMessageSlack>[2]) =>
        await sendMessageSlack(to, text, { ...opts, client: transport.client }),
    );
    const assertDirectAdapterHandoff = vi.fn();
    const signal = new AbortController().signal;
    const fields = ["Alpha", "Beta", "Gamma"].map((label) => ({
      type: "plain_text",
      text: label.padEnd(1_500, "."),
    }));
    const blocks = [{ type: "section", fields }];

    const result = await sendDurableMessageBatch({
      cfg,
      channel: "slack",
      to: "C123",
      payloads: [{ channelData: { slack: { blocks } } }],
      accountId: "default",
      assertDirectAdapterHandoff,
      signal,
    });

    assert(result.status === "sent", "error" in result ? String(result.error) : result.status);
    expect(transport.requestBodies).toHaveLength(1);
    const body = transport.requestBodies[0];
    assert(body);
    expect(body.get("channel")).toBe("C123");
    expect(decodeSlackBlocks(body)).toEqual(blocks);
    expect(body.get("text")).toBe(fields.map((field) => field.text).join("\n"));
    expect(body.get("mrkdwn")).toBe("false");
    const forwardedOptions = sendMessageSlackMock.mock.calls[0]?.[2];
    expect(forwardedOptions?.assertDirectAdapterHandoff).toEqual(expect.any(Function));
    expect(forwardedOptions?.signal).toBeInstanceOf(AbortSignal);
    expect(forwardedOptions?.signal?.aborted).toBe(false);
    expect(assertDirectAdapterHandoff).toHaveBeenCalled();
    expect(result.results[0]?.receipt?.platformMessageIds).toEqual(["171234.567"]);
    transport.assertExhausted();
  });

  it.each(["text", "context"] as const)(
    "preserves prose after a Windows root path in long %s presentations",
    async (type) => {
      const transport = createScriptedSlackWriteClient([{ ok: true, ts: "171234.567" }]);
      sendMessageSlackMock.mockImplementation(
        async (to: string, text: string, opts: Parameters<typeof sendMessageSlack>[2]) =>
          await sendMessageSlack(to, text, { ...opts, client: transport.client }),
      );
      const intro = "Install in `C:\\` and continue. ";
      const text = intro + "Ordinary prose. ".repeat(220) + "Done.";

      const result = await sendDurableMessageBatch({
        cfg,
        channel: "slack",
        to: "C123",
        payloads: [{ presentation: { blocks: [{ type, text }] } }],
        accountId: "default",
      });

      assert(result.status === "sent", "error" in result ? String(result.error) : result.status);
      expect(transport.requestBodies).toHaveLength(1);
      const body = transport.requestBodies[0];
      assert(body);
      expect(body.get("channel")).toBe("C123");
      expect(decodeSlackBlocks(body)).toEqual(
        [expect.stringContaining(intro), expect.not.stringContaining("`")].map((chunk) =>
          type === "context"
            ? {
                type: "context",
                elements: [{ type: "mrkdwn", text: chunk, verbatim: true }],
              }
            : { type: "section", text: { type: "mrkdwn", text: chunk } },
        ),
      );
      expect(result.results[0]?.receipt?.platformMessageIds).toEqual(["171234.567"]);
      transport.assertExhausted();
    },
  );

  it("preserves a field-rich section and every receipt when native table delivery falls back", async () => {
    const transport = createScriptedSlackWriteClient([
      { ok: false, error: "invalid_blocks" },
      { ok: true, ts: "171234.1" },
      { ok: true, ts: "171234.2" },
    ]);
    sendMessageSlackMock.mockImplementation(
      async (to: string, text: string, opts: Parameters<typeof sendMessageSlack>[2]) =>
        await sendMessageSlack(to, text, { ...opts, client: transport.client }),
    );
    const assertDirectAdapterHandoff = vi.fn();
    const signal = new AbortController().signal;
    const fields = ["Alpha", "Beta", "Gamma"].map((label) => ({
      type: "plain_text",
      text: label.padEnd(1_500, "."),
    }));
    const section = { type: "section", fields };
    const footer = { type: "section", text: { type: "plain_text", text: "End of report" } };
    const table = {
      type: "data_table",
      caption: "Pipeline",
      rows: [[{ type: "raw_text", text: "Account" }], [{ type: "raw_text", text: "Acme" }]],
    };
    const blocks = [section, table, footer];

    const result = await sendDurableMessageBatch({
      cfg,
      channel: "slack",
      to: "C123",
      payloads: [{ channelData: { slack: { blocks } } }],
      accountId: "default",
      assertDirectAdapterHandoff,
      signal,
    });

    assert(result.status === "sent", "error" in result ? String(result.error) : result.status);
    expect(transport.requestBodies).toHaveLength(3);
    const [initialBody, sectionBody, tableBody] = transport.requestBodies;
    assert(initialBody && sectionBody && tableBody);
    expect(decodeSlackBlocks(initialBody)).toEqual(blocks);
    expect(decodeSlackBlocks(sectionBody)).toEqual([section]);
    expect(sectionBody.get("text")).toBe(fields.map((field) => field.text).join("\n"));
    expect(sectionBody.get("mrkdwn")).toBe("false");
    expect(decodeSlackBlocks(tableBody)).toEqual([
      { type: "section", text: { type: "plain_text", text: "Pipeline (table)\nAccount\nAcme" } },
      footer,
    ]);
    expect(tableBody.get("text")).toBe("Pipeline (table)\nAccount\nAcme\n\nEnd of report");
    expect(tableBody.get("mrkdwn")).toBe("false");
    const forwardedOptions = sendMessageSlackMock.mock.calls[0]?.[2];
    expect(forwardedOptions?.assertDirectAdapterHandoff).toEqual(expect.any(Function));
    expect(forwardedOptions?.signal).toBeInstanceOf(AbortSignal);
    expect(forwardedOptions?.signal?.aborted).toBe(false);
    expect(assertDirectAdapterHandoff).toHaveBeenCalled();
    expect(result.results[0]?.receipt?.platformMessageIds).toEqual(["171234.1", "171234.2"]);
    transport.assertExhausted();
  });

  it("fires message_sending once with shared routing fields", async () => {
    const hookRegistry = createEmptyPluginRegistry();
    const handler = vi.fn().mockResolvedValue(undefined);
    addTestHook({
      registry: hookRegistry,
      pluginId: "test-plugin",
      hookName: "message_sending",
      handler: handler as PluginHookRegistration["handler"],
    });
    initializeGlobalHookRunner(hookRegistry);

    await sendDurableMessageBatch({
      cfg,
      channel: "slack",
      to: "C123",
      payloads: [{ text: "hello" }],
      accountId: "default",
      replyToId: "1712000000.000001",
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      {
        to: "C123",
        content: "hello",
        replyToId: "1712000000.000001",
        metadata: {
          channel: "slack",
          accountId: "default",
          mediaUrls: [],
        },
      },
      {
        channelId: "slack",
        accountId: "default",
        conversationId: "C123",
      },
    );
    expect(sendMessageSlackMock).toHaveBeenCalledTimes(1);
  });

  it("passes replyToId as Slack threadTs for threaded outbound delivery", async () => {
    await sendDurableMessageBatch({
      cfg,
      channel: "slack",
      to: "C123",
      payloads: [{ text: "hello" }],
      accountId: "default",
      replyToId: "1712000000.000001",
    });

    expect(sendMessageSlackMock).toHaveBeenCalledWith(
      "C123",
      "hello",
      expect.objectContaining({
        cfg,
        threadTs: "1712000000.000001",
        accountId: "default",
        onDeliveryResult: expect.any(Function),
      }),
    );
  });

  it("respects cancel from the shared hook without a second adapter pass", async () => {
    const hookRegistry = createEmptyPluginRegistry();
    const handler = vi.fn().mockResolvedValue({ cancel: true });
    addTestHook({
      registry: hookRegistry,
      pluginId: "test-plugin",
      hookName: "message_sending",
      handler: handler as PluginHookRegistration["handler"],
    });
    initializeGlobalHookRunner(hookRegistry);

    const result = await sendDurableMessageBatch({
      cfg,
      channel: "slack",
      to: "C123",
      payloads: [{ text: "hello" }],
      accountId: "default",
      replyToId: "1712000000.000001",
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(sendMessageSlackMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "suppressed", results: [] });
  });
});
