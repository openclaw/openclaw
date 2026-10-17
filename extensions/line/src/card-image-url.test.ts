import { createServer } from "node:http";
import type { messagingApi } from "@line/bot-sdk";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createActionCard, createImageCard } from "./flex-templates/basic-cards.js";
import { renderLineCard } from "./rich-messages.js";
import { pushMessagesLine, replyMessageLine } from "./send.js";
import { buildTemplateMessageFromPayload } from "./template-messages.js";

vi.mock("openclaw/plugin-sdk/plugin-config-runtime", () => ({
  requireRuntimeConfig: (cfg: unknown) => cfg,
}));
vi.mock("./accounts.js", () => ({ resolveLineAccount: () => ({ accountId: "default" }) }));
vi.mock("./channel-access-token.js", () => ({
  resolveLineChannelAccessToken: () => "line-card-wire-test-token",
}));
vi.mock("openclaw/plugin-sdk/channel-activity-runtime", () => ({
  recordChannelActivity: () => {},
}));

type WireRequest = {
  method: string;
  path: string;
  authorization: string;
  body: { to?: string; replyToken?: string; messages: messagingApi.Message[] };
};

const imageUrl = "https://example.com/cover.jpg";
const videoUrl = "https://example.com/clip.mp4";
const videoBase = { type: "video" as const, url: videoUrl, previewUrl: imageUrl };
const image: messagingApi.FlexImage = { type: "image", url: imageUrl };
const action: messagingApi.MessageAction = { type: "message", label: "Choose", text: "choose" };
const flexText = (text: string): messagingApi.FlexText => ({ type: "text", text });
const box = (
  contents: messagingApi.FlexComponent[],
  layout: messagingApi.FlexBox["layout"] = "vertical",
): messagingApi.FlexBox => ({ type: "box", layout, contents });
const flex = (altText: string, contents: messagingApi.FlexContainer): messagingApi.FlexMessage => ({
  type: "flex",
  altText,
  contents,
});
const caption = box([flexText("Original caption")]);
const invalidImage = "http://example.com/cover.jpg";
const warning = expect.objectContaining({
  type: "text",
  text: "Image unavailable: URL must use HTTPS.",
});
const byteLength = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

function videoMessage(
  url: string,
  altContent: messagingApi.FlexComponent,
  overrides: Partial<messagingApi.FlexVideo> = {},
): messagingApi.FlexMessage {
  return flex("Video card", {
    type: "bubble",
    size: "mega",
    hero: { ...videoBase, url, altContent, aspectRatio: "20:13", ...overrides },
    body: caption,
  });
}

function bubble(message: messagingApi.Message): messagingApi.FlexBubble {
  if (message.type !== "flex" || message.contents.type !== "bubble") {
    throw new Error("Expected a Flex bubble");
  }
  return message.contents;
}

type CardCase = {
  name: string;
  message: () => messagingApi.Message;
  verify: (message: messagingApi.Message) => void;
  reply?: boolean;
};
const cardCase = (
  name: string,
  message: CardCase["message"],
  verify: CardCase["verify"],
): CardCase => ({ name, message, verify });
const preservedVideo = (
  name: string,
  alternative: messagingApi.FlexComponent,
  expected: unknown,
  overrides: Partial<messagingApi.FlexVideo> = {},
) =>
  cardCase(
    name,
    () => videoMessage(videoUrl, alternative, overrides),
    (message) => {
      expect(bubble(message)).toMatchObject({
        hero: { ...videoBase, altContent: expected, ...overrides },
      });
      expect(bubble(message).body?.contents[0]).toEqual(caption.contents[0]);
    },
  );
const carouselColumn = (index: number) => ({
  title: `Item ${index + 1}`,
  text: `Caption ${index + 1}`,
  actions: [action],
});
const templateMessage = (payload: Parameters<typeof buildTemplateMessageFromPayload>[0]) =>
  expectDefined(buildTemplateMessageFromPayload(payload), "template message");
const payloadAction = { type: "message" as const, label: "Choose", data: "choose" };
const cases: CardCase[] = [
  cardCase(
    "valid video and image alternative remain unchanged",
    () => videoMessage(videoUrl, image),
    (message) => expect(message).toEqual(videoMessage(videoUrl, image)),
  ),
  preservedVideo(
    "valid video retains required alternative when its image URL is invalid",
    { type: "image", url: invalidImage },
    box([{ type: "text", text: expect.stringContaining("Image unavailable") }]),
  ),
  {
    name: "mixed carousel image URLs retain consistent image presence",
    reply: true,
    message: () => ({
      type: "template",
      altText: "Choose an item",
      template: {
        type: "carousel",
        columns: [imageUrl, invalidImage].map((thumbnailImageUrl, index) =>
          Object.assign(carouselColumn(index), { thumbnailImageUrl }),
        ),
      },
    }),
    verify: (message) => {
      if (message.type !== "template" || message.template.type !== "carousel") {
        throw new Error("Expected a template carousel");
      }
      expect(message.template.columns).toEqual([carouselColumn(0), carouselColumn(1)]);
    },
  },
];

for (const url of ["http://example.com/cover.jpg", "cover.jpg"]) {
  cases.push({
    name: `omits an image-card hero with unsupported URL ${JSON.stringify(url)}`,
    message: () => flex("Product", createImageCard(url, "Product", "Caption")),
    verify: (message) => {
      const card = bubble(message);
      expect(card.hero).toBeUndefined();
      expect(card.body?.contents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "text", text: "Product" }),
          expect.objectContaining({ type: "text", text: "Caption" }),
          warning,
        ]),
      );
    },
  });
}

cases.push(
  {
    name: "keeps action-card controls when the image is unavailable",
    message: () =>
      flex("Menu", createActionCard("Menu", "Choose", [action], { imageUrl: invalidImage })),
    verify: (message) => {
      const card = bubble(message);
      expect(card.hero).toBeUndefined();
      expect(card.footer?.contents).toEqual([expect.objectContaining({ type: "button", action })]);
    },
  },
  {
    name: "normalizes the typed media-player card at final send",
    message: () => {
      const card = renderLineCard({ type: "media_player", title: "Song", imageUrl: invalidImage });
      return flex(card.altText, card.contents as messagingApi.FlexContainer);
    },
    verify: (message) => {
      const card = bubble(message);
      expect(card.hero).toBeUndefined();
      expect(card.body?.contents).toEqual(expect.arrayContaining([warning]));
      expect(card.footer?.contents.length).toBeGreaterThan(0);
    },
  },
  {
    name: "removes nested invalid images and baseline icons without losing their siblings",
    reply: true,
    message: () =>
      flex("Nested media", {
        type: "bubble",
        body: box([
          box(
            [
              { type: "icon", url: "http://example.com/icon.png" },
              { type: "icon", url: imageUrl },
              flexText("Label"),
            ],
            "baseline",
          ),
          box([{ type: "image", url: invalidImage }]),
          image,
        ]),
      }),
    verify: (message) =>
      expect(bubble(message).body?.contents).toEqual([
        box([{ type: "icon", url: imageUrl }, flexText("Label")], "baseline"),
        box([]),
        image,
        warning,
      ]),
  },
  {
    name: "scopes image warnings to the affected Flex carousel bubble",
    message: () => ({
      type: "flex",
      altText: "Cards",
      contents: {
        type: "carousel",
        contents: [
          createImageCard("http://example.com/cover.jpg", "First", "Caption"),
          createImageCard(imageUrl, "Second", "Caption"),
        ],
      },
    }),
    verify: (message) => {
      if (message.type !== "flex" || message.contents.type !== "carousel") {
        throw new Error("Expected Flex carousel");
      }
      const first = expectDefined(message.contents.contents[0], "first bubble");
      expect(first.hero).toBeUndefined();
      expect(first.body?.contents).toEqual(expect.arrayContaining([warning]));
      expect(message.contents.contents[1]).toEqual(createImageCard(imageUrl, "Second", "Caption"));
    },
  },
  preservedVideo(
    "retains a video alternative box when a nested image is removed",
    box([flexText("Alternative caption"), { type: "image", url: invalidImage }]),
    box([flexText("Alternative caption")]),
  ),
  preservedVideo("retains allowed HTTP action links on valid video media", image, image, {
    action: { type: "uri", label: "Open", uri: "http://example.com/action" },
  }),
);

for (const field of ["url", "previewUrl"] as const) {
  cases.push(
    cardCase(
      `invalid video ${field} preserves its image alternative`,
      () => videoMessage(videoUrl, image, { [field]: invalidImage }),
      (message) => {
        const card = bubble(message);
        expect([card.hero, card.body?.contents[0]]).toEqual([image, caption.contents[0]]);
      },
    ),
  );
}

for (const thumbnailImageUrl of ["http://example.com/cover.jpg", imageUrl]) {
  cases.push({
    name: `buttons-template thumbnail ${thumbnailImageUrl}`,
    message: () =>
      templateMessage({
        type: "buttons",
        title: "Menu",
        text: "Choose",
        thumbnailImageUrl,
        actions: [payloadAction],
      }),
    verify: (message) => {
      if (message.type !== "template" || message.template.type !== "buttons") {
        throw new Error("Expected buttons template");
      }
      expect(message.template.thumbnailImageUrl).toBe(
        thumbnailImageUrl === imageUrl ? imageUrl : undefined,
      );
      expect(message.template).toMatchObject({ title: "Menu", text: "Choose", actions: [action] });
    },
  });
}

for (const thumbnails of [
  [imageUrl, imageUrl],
  [undefined, imageUrl],
]) {
  cases.push({
    name: `carousel thumbnails ${JSON.stringify(thumbnails)}`,
    message: () =>
      templateMessage({
        type: "carousel",
        columns: thumbnails.map((thumbnailImageUrl, index) => ({
          ...carouselColumn(index),
          thumbnailImageUrl,
          actions: [payloadAction],
        })),
      }),
    verify: (message) => {
      if (message.type !== "template" || message.template.type !== "carousel") {
        throw new Error("Expected template carousel");
      }
      const allImagesValid = thumbnails.every((url) => url === imageUrl);
      expect(message.template.columns.map((column) => column.thumbnailImageUrl)).toEqual(
        allImagesValid ? thumbnails : [undefined, undefined],
      );
      expect(message.template.columns).toEqual(
        [0, 1].map((index) => expect.objectContaining(carouselColumn(index))),
      );
    },
  });
}

for (const shape of ["bubble", "carousel"] as const) {
  const limit = shape === "bubble" ? 30_000 : 50_000;
  const makeNearLimitCard = (): messagingApi.FlexMessage => {
    const captions = Array.from({ length: shape === "bubble" ? 20 : 40 }, (_, index) =>
      flexText(`Original caption ${index % 20}: `),
    );
    const cards = Array.from(
      { length: captions.length / 20 },
      (_, index): messagingApi.FlexBubble => ({
        type: "bubble",
        body: box([
          box([{ type: "icon", url: "http://x" }, flexText("Original title")], "baseline"),
          ...captions.slice(index * 20, (index + 1) * 20),
        ]),
        footer: box([{ type: "button", action }]),
      }),
    );
    const contents =
      shape === "bubble"
        ? expectDefined(cards[0], "bubble")
        : { type: "carousel" as const, contents: cards };
    let remaining = limit - 50 - byteLength(contents);
    for (const [index, text] of captions.entries()) {
      const bytes = Math.floor(remaining / (captions.length - index));
      text.text += "界".repeat(Math.floor(bytes / 3)) + "x".repeat(bytes % 3);
      remaining -= bytes;
    }
    expect(byteLength(contents)).toBe(limit - 50);
    return { type: "flex", altText: "Near-limit card", contents };
  };
  cases.push({
    name: `keeps a near-limit UTF-8 ${shape} deliverable when removing invalid media`,
    message: makeNearLimitCard,
    verify: (message) => {
      if (message.type !== "flex") {
        throw new Error("Expected a Flex message");
      }
      expect(byteLength(message.contents)).toBeLessThanOrEqual(limit);
      const original = makeNearLimitCard().contents;
      const before = original.type === "bubble" ? [original] : original.contents;
      const after =
        message.contents.type === "bubble" ? [message.contents] : message.contents.contents;
      expect(after).toHaveLength(before.length);
      for (const [index, card] of after.entries()) {
        expect(byteLength(card)).toBeLessThanOrEqual(30_000);
        expect(card.body?.contents[0]).toEqual(box([flexText("Original title")], "baseline"));
        expect(card.body?.contents.slice(1, 21)).toEqual(before[index]?.body?.contents.slice(1));
        expect(card.footer).toEqual(before[index]?.footer);
      }
    },
  });
}

const unchangedMessages: messagingApi.Message[] = [
  { type: "audio", originalContentUrl: "https://example.com/audio.mp3", duration: 1000 },
  {
    type: "template",
    altText: "Pictures",
    template: { type: "image_carousel", columns: [{ imageUrl, action }] },
  },
  { type: "text", text: "Choose", quickReply: { items: [{ type: "action", imageUrl, action }] } },
];
for (const message of unchangedMessages) {
  cases.push({
    name: `retains sibling ${message.type} message media`,
    message: () => message,
    verify: (received) => expect(received).toEqual(message),
  });
}

describe("LINE card shape on the actual push and reply wire", () => {
  let requests: WireRequest[] = [];
  let localOrigin: string;
  let realFetch: typeof globalThis.fetch;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.once("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as WireRequest["body"];
      requests.push({
        method: request.method ?? "",
        path: request.url ?? "",
        authorization: request.headers.authorization ?? "",
        body,
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ sentMessages: [{ id: "card-wire-message" }] }));
    });
  });

  beforeAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("No loopback TCP address");
    }
    realFetch = globalThis.fetch;
    localOrigin = `http://127.0.0.1:${address.port}`;
  });

  beforeEach(() => {
    requests = [];
    const fetchLoopback = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        );
        if (url.hostname !== "api.line.me") {
          throw new Error(`Unexpected destination: ${url.hostname}`);
        }
        return realFetch(new URL(url.pathname, localOrigin), init);
      },
      { mock: {} },
    );
    vi.stubGlobal("fetch", fetchLoopback);
  });

  afterEach(() => vi.unstubAllGlobals());

  afterAll(async () => {
    vi.unstubAllGlobals();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    vi.doUnmock("openclaw/plugin-sdk/plugin-config-runtime");
    vi.doUnmock("./accounts.js");
    vi.doUnmock("./channel-access-token.js");
    vi.doUnmock("openclaw/plugin-sdk/channel-activity-runtime");
    vi.resetModules();
  });

  for (const operation of ["push", "reply"] as const) {
    // Push owns the shared normalizer matrix; reply verifies its transport wiring.
    const operationCases = operation === "push" ? cases : cases.filter(({ reply }) => reply);
    it.each(operationCases)(`${operation}: $name`, async ({ message, verify }) => {
      const original = message();
      const originalBytes = JSON.stringify(original);
      if (operation === "push") {
        await pushMessagesLine("line:user:UcardWire", [original], { cfg: {} });
      } else {
        await replyMessageLine("card-wire-reply-token", [original], { cfg: {} });
      }
      const request = expectDefined(requests[0], "LINE HTTP request");
      expect(requests).toHaveLength(1);
      expect(request).toMatchObject({
        method: "POST",
        path: `/v2/bot/message/${operation}`,
        authorization: "Bearer line-card-wire-test-token",
        body: operation === "push" ? { to: "UcardWire" } : { replyToken: "card-wire-reply-token" },
      });
      expect(JSON.stringify(original)).toBe(originalBytes);
      verify(expectDefined(request.body.messages[0], "LINE wire message"));
    });
  }
});
