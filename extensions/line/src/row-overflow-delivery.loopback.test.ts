import { json } from "node:stream/consumers";
import type { messagingApi } from "@line/bot-sdk";
import {
  adaptMessagePresentationForChannel,
  type MessagePresentation,
} from "openclaw/plugin-sdk/interactive-runtime";
import { chunkMarkdownText } from "openclaw/plugin-sdk/reply-runtime";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { afterAll, afterEach, aroundEach, beforeEach, expect, it, vi } from "vitest";
import type { PluginRuntime, ReplyPayload } from "../api.js";
import { deliverLineAutoReply } from "./auto-reply-delivery.js";
import { baseDeliveryParams, createDeps } from "./auto-reply-delivery.test-helpers.js";
import { createImageCard } from "./flex-templates/basic-cards.js";
import { processLineMessage } from "./markdown-to-line.js";
import { lineOutboundAdapter } from "./outbound.js";
import { LINE_PRESENTATION_CAPABILITIES, prepareLineReplyPayload } from "./rich-messages.js";
import { setLineRuntime } from "./runtime.js";
import { createFlexMessage, pushMessagesLine, replyMessageLine } from "./send.js";
import type { LineChannelData } from "./types.js";

type WireMessage = {
  type: string;
  text?: string;
  altText?: string;
  template?: messagingApi.Template;
  actions?: messagingApi.ImagemapAction[];
  video?: messagingApi.ImagemapVideo;
  quickReply?: { items: Array<{ action: { label: string; text?: string; data?: string } }> };
};

type RecordedLineApiRequest = {
  path: string;
  authorization: string;
  body: {
    to?: string;
    messages: WireMessage[];
  };
};

const LINE_TEST_CFG = { channels: { line: { accounts: { default: {} } } } };

const recordChannelActivityMock = vi.hoisted(() => vi.fn());

// mock-isolation: Pin reads to loopback configuration, not the operator runtime.
vi.mock("openclaw/plugin-sdk/plugin-config-runtime", () => ({
  requireRuntimeConfig: vi.fn((cfg: unknown) => cfg ?? LINE_TEST_CFG),
}));

// mock-isolation: Pin the loopback account without loading operator accounts.
vi.mock("./accounts.js", () => ({ resolveLineAccount: vi.fn(() => ({ accountId: "default" })) }));

// mock-isolation: Use the synthetic token without reading stored credentials.
vi.mock("./channel-access-token.js", () => ({
  resolveLineChannelAccessToken: vi.fn(() => "line-loopback-proof-token"),
}));

vi.mock("openclaw/plugin-sdk/channel-activity-runtime", () => ({
  recordChannelActivity: recordChannelActivityMock,
}));

vi.mock("openclaw/plugin-sdk/runtime-env", async (importOriginal) => {
  return {
    ...(await importOriginal<typeof import("openclaw/plugin-sdk/runtime-env")>()),
    logVerbose: vi.fn(),
  };
});

// mock-isolation: Route transport to the owned loopback server without external DNS.
vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  resolvePinnedHostnameWithPolicy: vi.fn(async () => ({
    hostname: "api.line.me",
    addresses: ["127.0.0.1"],
  })),
}));

function wireText(messages: WireMessage[]) {
  return messages
    .filter((message) => message.type === "text")
    .map((message) => message.text)
    .join(" ");
}

function sendPayload(to: string, text: string, extra: Partial<ReplyPayload> = {}) {
  return lineOutboundAdapter.sendPayload!({
    to: `line:user:${to}`,
    text,
    payload: { text, ...extra },
    cfg: LINE_TEST_CFG,
  });
}

const continueReply = { items: [{ action: { label: "Continue", text: "Continue" } }] };

let requests: RecordedLineApiRequest[];
let loopbackOrigin: string;

aroundEach(async (runTest) => {
  await withServer(
    (request, response) => {
      void (async () => {
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        const body = (await json(request)) as RecordedLineApiRequest["body"];
        const respond = (status: number, data: unknown) => {
          response.writeHead(status, { "content-type": "application/json" });
          response.end(JSON.stringify(data));
        };
        requests.push({
          path: url.pathname,
          authorization: (request.headers.authorization as string) ?? "",
          body,
        });

        if (
          url.pathname === "/v2/bot/message/push" &&
          body.to === "UtestAutoReplyRecovery" &&
          body.messages.some((message) => message.type === "flex")
        ) {
          respond(400, { message: "invalid rich message" });
          return;
        }

        if (url.pathname === "/v2/bot/message/push" || url.pathname === "/v2/bot/message/reply") {
          respond(200, { sentMessages: body.messages.map((_, i) => ({ id: `loopback-${i}` })) });
          return;
        }

        respond(404, { message: "not found" });
      })().catch((error: unknown) => {
        response.writeHead(500, { "content-type": "text/plain" });
        response.end(String(error));
      });
    },
    async (baseUrl) => {
      loopbackOrigin = baseUrl;
      await runTest();
    },
  );
});

beforeEach(() => {
  requests = [];
  recordChannelActivityMock.mockReset();
  const originalFetch = globalThis.fetch;
  const loopbackFetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);

    if (url.hostname === "api.line.me") {
      const redirectedUrl = new URL(`${url.pathname}${url.search}`, loopbackOrigin);
      return originalFetch(redirectedUrl.toString(), init);
    }

    return originalFetch(input, init);
  };
  vi.stubGlobal("fetch", Object.assign(loopbackFetch, { mock: {} }));
  setLineRuntime({
    channel: { text: { chunkMarkdownText, resolveTextChunkLimit: () => 5000 } },
  } as unknown as PluginRuntime);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(() => {
  vi.doUnmock("openclaw/plugin-sdk/plugin-config-runtime");
  vi.doUnmock("./accounts.js");
  vi.doUnmock("./channel-access-token.js");
  vi.doUnmock("openclaw/plugin-sdk/channel-activity-runtime");
  vi.doUnmock("openclaw/plugin-sdk/runtime-env");
  vi.doUnmock("openclaw/plugin-sdk/ssrf-runtime");
  vi.resetModules();
});

it.each(["push", "reply"] as const)(
  "normalizes action contracts before %s HTTP delivery",
  async (operation) => {
    const link = {
      type: "uri",
      uri: "https://example.com",
      altUri: { desktop: "ftp://example.com" },
    } as const;
    const postback = {
      type: "postback",
      label: "Run",
      data: "",
      text: "Legacy",
      displayText: "Modern",
      fillInText: "x".repeat(301),
    } as const;
    const imageMessage = {
      type: "flex",
      altText: "Image",
      contents: createImageCard("https://example.com/image.png", "Image"),
    } satisfies messagingApi.FlexMessage;
    const messages: messagingApi.Message[] = [
      {
        type: "text",
        text: "Choose",
        quickReply: {
          items: [
            { action: { type: "message", label: "Missing text" } },
            { action: { type: "message", label: "", text: "blank" } },
            ...Array.from({ length: 14 }, (_, i) => ({
              action: { type: "message" as const, label: String(i), text: String(i) },
              imageUrl: "http://example.com/icon.png",
            })),
          ],
        },
      },
      { type: "text", text: "No buttons", quickReply: { items: [] } },
      imageMessage,
      {
        type: "template",
        altText: "Menu",
        template: {
          type: "buttons",
          text: "Choose",
          defaultAction: link,
          actions: [
            { type: "camera", label: "Camera" },
            postback,
            {
              type: "datetimepicker",
              label: "Date",
              data: "date",
              mode: "datetime",
              initial: "2026-02-30T12:00",
              min: "2026-06-01T10:00",
              max: "2026-06-01t09:00",
            },
            { type: "clipboard", label: "Copy", clipboardText: "" },
          ],
        },
      },
      {
        type: "imagemap",
        baseUrl: "https://example.com/map",
        altText: "Map",
        baseSize: { width: 1040, height: 1040 },
        actions: [
          {
            type: "uri",
            linkUri: "ftp://example.com",
            area: { x: 0, y: 0, width: 100, height: 100 },
          },
        ],
        video: {
          originalContentUrl: "https://example.com/video.mp4",
          previewImageUrl: "https://example.com/preview.png",
          area: { x: 0, y: 0, width: 100, height: 100 },
          externalLink: { linkUri: "https://example.com", label: "" },
        },
      },
    ];
    if (operation === "push") {
      await pushMessagesLine("U123", messages, { cfg: LINE_TEST_CFG });
    } else {
      await replyMessageLine("reply-token", messages, { cfg: LINE_TEST_CFG });
    }
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request).toMatchObject({
      authorization: "Bearer line-loopback-proof-token",
      path: "/v2/bot/message/" + operation,
    });
    const [quick, empty, image, menu, map] = request.body.messages;
    expect(quick?.quickReply?.items).toEqual(
      Array.from({ length: 13 }, (_, i) => ({
        type: "action",
        action: { type: "message", label: String(i), text: String(i) },
      })),
    );
    expect(empty).not.toHaveProperty("quickReply");
    expect(image).toEqual(imageMessage);
    if (
      menu?.type !== "template" ||
      menu.template?.type !== "buttons" ||
      map?.type !== "imagemap"
    ) {
      throw new Error("Expected menu and map");
    }
    expect(menu.template).not.toHaveProperty("defaultAction");
    expect(menu.template.actions).toEqual([
      { type: "message", label: "Unavailable", text: expect.stringContaining("quick replies") },
      { type: "postback", label: "Run", data: "", displayText: "Modern" },
      { type: "datetimepicker", label: "Date", data: "date", mode: "datetime" },
      { type: "message", label: "Unavailable", text: expect.stringContaining("clipboard") },
    ]);
    expect(map.actions).toHaveLength(2);
    expect(map.actions?.every((action) => action.type === "message")).toBe(true);
    expect(map.video).not.toHaveProperty("externalLink");
  },
);

it.each([
  { delivery: "reply", card: false },
  { delivery: "push", card: true },
])("carries every select through $delivery requests (card=$card)", async ({ delivery, card }) => {
  const selects = ["environment", "region", "version"].map((kind) => ({
    type: "select" as const,
    placeholder: `Which ${kind} should receive this deployment?`,
    options: Array.from({ length: 8 }, (_, index) => ({
      label: `${kind}-${index + 1} full deployment name`,
      action: { type: "command" as const, command: `/${kind} ${index + 1}` },
    })),
  }));
  const help = { type: "command", command: "/help" } as const;
  const presentation: MessagePresentation = {
    title: "Deployment choices",
    blocks: [
      { type: "context", text: "Review all three choices." },
      ...(card ? [{ type: "buttons" as const, buttons: [{ label: "Help", action: help }] }] : []),
      ...selects,
    ],
  };
  const payload = { text: "Deployment details. ".repeat(1_500), presentation };
  const prepared =
    delivery === "reply"
      ? await prepareLineReplyPayload(payload)
      : await lineOutboundAdapter.renderPresentation!({
          payload,
          presentation: adaptMessagePresentationForChannel({
            presentation,
            capabilities: LINE_PRESENTATION_CAPABILITIES,
          }),
          ctx: {} as never,
        });
  if (!prepared) {
    throw new Error("LINE presentation did not render");
  }
  if (delivery === "reply") {
    createDeps({
      processLineMessage,
      chunkMarkdownText,
      createFlexMessage,
      pushMessagesLine,
      replyMessageLine,
    });
    await deliverLineAutoReply({
      ...baseDeliveryParams,
      cfg: LINE_TEST_CFG,
      accountId: "default",
      payload: prepared,
      lineData: prepared.channelData?.line as LineChannelData,
    });
  } else {
    await lineOutboundAdapter.sendPayload!({
      to: "line:user:Uselect",
      text: prepared.text ?? "",
      payload: prepared,
      cfg: LINE_TEST_CFG,
    });
  }

  const messages = requests.flatMap((request) => request.body.messages);
  const text = wireText(messages);
  const options = selects.flatMap((select) => select.options);
  const controls = messages.flatMap((message) => message.quickReply?.items ?? []);
  expect(requests.length).toBeGreaterThan(1);
  expect(requests.every((request) => request.body.messages.length <= 5)).toBe(true);
  expect(requests[0]?.path).toBe(`/v2/bot/message/${delivery}`);
  expect(controls).toHaveLength(13);
  expect(controls.map(({ action }) => action.text)).toEqual(
    options.slice(0, 13).map((option) => option.action.command),
  );
  expect(controls.every(({ action }) => Array.from(action.label).length <= 20)).toBe(true);
  expect(messages.filter((message) => message.quickReply)).toEqual([messages.at(-1)]);
  for (const select of selects) {
    expect(text).toContain(select.placeholder);
  }
  for (const option of options.slice(13)) {
    expect(text).toContain(`${option.label}: ${option.action.command}`);
  }
  expect(messages.filter((message) => message.type === "flex")).toHaveLength(card ? 1 : 0);
  expect(text.includes(presentation.title!)).toBe(!card);
});

it("preserves source order of kept Flex card alongside overflow text through the production outbound adapter", async () => {
  const keptTable = "| Small | Card |\n|---|---|\n| Kept | row |";
  const bigRows = Array.from({ length: 13 }, (_, i) => `| Big${i + 1} | $${i + 1}.00 |`).join("\n");
  const overflowTable = `| Name | Price |\n|---|---|\n${bigRows}`;
  const markdown = `Header\n\n${keptTable}\n\nBetween\n\n${overflowTable}\n\nFooter`;

  await sendPayload("UtestMixed", markdown);

  const allMessages = requests.flatMap((request) => request.body.messages);
  const firstFlexIdx = allMessages.findIndex((message) => message.type === "flex");
  expect(firstFlexIdx).toBeGreaterThanOrEqual(0);
  const beforeFlex = allMessages.slice(0, firstFlexIdx);
  const afterFlex = allMessages.slice(firstFlexIdx + 1);

  const beforeText = wireText(beforeFlex);
  const afterText = wireText(afterFlex);

  expect(beforeText).toContain("Header");
  expect(afterText).toContain("Big1");
  expect(afterText).toContain("Big13");
  expect(afterText).toContain("Footer");

  expect(beforeText).not.toContain("Big1");
  expect(afterText).not.toContain("Header");

  const allText = wireText(allMessages);
  for (let i = 1; i <= 13; i++) {
    expect(allText).toContain(`Big${i}`);
  }
});

it("delivers every line of an oversized code block through the production outbound adapter", async () => {
  const code = Array.from({ length: 120 }, (_, i) => `const line${i} = ${i}; // padding pad`).join(
    "\n",
  );
  const markdown = `Header\n\n\`\`\`ts\n${code}\n\`\`\`\n\nFooter`;
  expect(code.length).toBeGreaterThan(2000);

  await sendPayload("UtestCodeOverflow", markdown);

  const allMessages = requests.flatMap((request) => request.body.messages);
  const allText = wireText(allMessages);

  for (const line of [0, 60, 119]) {
    expect(allText).toContain(`const line${line} = ${line};`);
  }
  expect(allText).not.toContain("\n...");
  expect(allText).toContain("Header");
  expect(allText).toContain("Footer");
  expect(allText.indexOf("Header")).toBeLessThan(allText.indexOf("const line0"));
  expect(allText.indexOf("const line119")).toBeLessThan(allText.indexOf("Footer"));
  expect(allMessages.some((message) => message.altText === "Code")).toBe(false);
});

it("keeps rendered-code quick replies on final media on the actual LINE HTTP wire", async () => {
  const markdown = "```js\nfirst()\n```";

  await sendPayload("UtestRichMedia", markdown, {
    mediaUrl: "https://example.com/image.jpg",
    channelData: { line: { quickReplies: ["Continue"] } },
  });

  expect(requests).toHaveLength(1);
  expect(requests[0]?.body.messages).toMatchObject([
    { type: "flex", altText: "Code" },
    {
      type: "image",
      originalContentUrl: "https://example.com/image.jpg",
      quickReply: continueReply,
    },
  ]);
});

it("preserves quick replies when LINE rejects the final Markdown card", async () => {
  createDeps({ processLineMessage, chunkMarkdownText, pushMessagesLine });

  const result = await deliverLineAutoReply({
    ...baseDeliveryParams,
    cfg: LINE_TEST_CFG,
    accountId: "default",
    to: "line:user:UtestAutoReplyRecovery",
    replyToken: undefined,
    payload: { text: "Choose one\n\n```js\nfirst()\n```" },
    lineData: { quickReplies: ["Continue"] },
  });

  const pushed = (messages: unknown[]) => ({
    path: "/v2/bot/message/push",
    body: { to: "UtestAutoReplyRecovery", messages },
  });
  expect(requests).toMatchObject([
    pushed([
      { type: "text", text: "Choose one" },
      { type: "flex", altText: "Code", quickReply: continueReply },
    ]),
    pushed([{ type: "text", text: "Choose one", quickReply: continueReply }]),
  ]);
  expect(recordChannelActivityMock).toHaveBeenCalledOnce();
  expect(result).toMatchObject({ status: "partial", visibleReplySent: true });
});
