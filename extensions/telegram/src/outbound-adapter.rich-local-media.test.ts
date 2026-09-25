import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getOrCreateAccountThrottler } from "./account-throttler.js";
import { apiThrottler } from "./bot.runtime.js";
import type { TelegramInputRichMessage } from "./rich-message.js";
import { resetTelegramAccountThrottlersForTest } from "./runtime.test-support.js";
import {
  resolveTelegramTestUpload,
  useTelegramHttpFixture,
} from "./send.telegram-http.test-support.js";

function richMessage(fields: Record<string, unknown>): TelegramInputRichMessage {
  return typeof fields.rich_message === "string"
    ? (JSON.parse(fields.rich_message) as TelegramInputRichMessage)
    : (fields.rich_message as TelegramInputRichMessage);
}

describe("Telegram rich local media through the outbound adapter", () => {
  const fixture = useTelegramHttpFixture();
  const { cfg, requests, rejections, telegramOutbound } = fixture;
  let photoBytes: Buffer;
  let voicePath: string;
  let videoPath: string;
  let documentPath: string;
  let secondDocumentPath: string;
  let allowedDir: string;

  const richConfig = () => ({
    channels: { telegram: { ...cfg.channels.telegram, richMessages: true } },
  });

  beforeAll(async () => {
    photoBytes = await fs.readFile(fixture.photoPath);
    voicePath = path.join(fixture.mediaDir, "voice.ogg");
    videoPath = path.join(fixture.mediaDir, "note.mp4");
    documentPath = path.join(fixture.mediaDir, "notes.pdf");
    secondDocumentPath = path.join(fixture.mediaDir, "appendix.pdf");
    allowedDir = path.join(fixture.mediaDir, "allowed");
    await fs.mkdir(allowedDir);
    await fs.writeFile(
      voicePath,
      Buffer.concat([
        Buffer.from("OggS"),
        Buffer.alloc(24),
        Buffer.from("OpusHead"),
        Buffer.alloc(32),
      ]),
    );
    await fs.writeFile(
      videoPath,
      Buffer.from("00000018667479706d703432000000006d70343269736f6d", "hex"),
    );
    await fs.writeFile(documentPath, "%PDF-1.7 local attachment");
    await fs.writeFile(secondDocumentPath, "%PDF-1.7 second local attachment");
  });

  beforeEach(() => {
    resetTelegramAccountThrottlersForTest();
    // Keep the real queue while avoiding Telegram's wall-clock pacing in loopback proof.
    getOrCreateAccountThrottler(cfg.channels.telegram.botToken, () =>
      apiThrottler({ global: {}, group: { maxConcurrent: 1 }, out: { maxConcurrent: 1 } }),
    );
  });
  afterEach(resetTelegramAccountThrottlersForTest);

  it.each(["host access", "legacy reader"] as const)(
    "preserves %s on text-only local image delivery",
    async (access) => {
      const readFile = vi.fn(async (filePath: string) => fs.readFile(filePath));
      const text =
        access === "host access"
          ? `Before <figure><img src="${fixture.photoPath}"/></figure> after`
          : `Before\n\n![Chart](${fixture.photoPath})\n\nafter`;
      const result = await telegramOutbound.sendText!({
        cfg: richConfig(),
        to: "123",
        text,
        ...(access === "host access"
          ? {
              mediaAccess: { localRoots: [fixture.mediaDir], readFile },
              mediaLocalRoots: [allowedDir],
            }
          : { mediaLocalRoots: [fixture.mediaDir], mediaReadFile: readFile }),
      });

      expect(readFile).toHaveBeenCalledExactlyOnceWith(fixture.photoPath);
      expect(requests.map(({ method }) => method)).toEqual(["sendRichMessage"]);
      const fields = requests[0]!.fields;
      const rich = richMessage(fields);
      expect(rich.blocks).toMatchObject([
        { type: "paragraph", text: "Before" },
        { type: "photo" },
        { type: "paragraph", text: "after" },
      ]);
      const photo = rich.blocks.find((block) => block.type === "photo");
      if (photo?.type !== "photo") {
        throw new Error("Expected an uploaded rich photo block");
      }
      const upload = resolveTelegramTestUpload({ ...fields, photo: photo.photo.media }, "photo");
      expect(upload.name).toBe("pixel.png");
      expect(Buffer.from(await upload.arrayBuffer())).toEqual(photoBytes);
      expect(rich.media).toBeUndefined();
      expect(result.receipt?.platformMessageIds ?? [result.messageId]).toEqual(["1"]);
    },
  );

  it.each(["host access", "legacy reader"] as const)(
    "enforces explicit roots before reading or uploading a temp file with %s",
    async (access) => {
      const readFile = vi.fn(async (filePath: string) => fs.readFile(filePath));
      // The existing fixture photo is under the process temp root, but outside allowedDir.
      await expect(
        telegramOutbound.sendText!({
          cfg: richConfig(),
          to: "123",
          text: `<img src="${fixture.photoPath}"/>`,
          ...(access === "host access"
            ? { mediaAccess: { localRoots: [allowedDir], readFile } }
            : { mediaLocalRoots: [allowedDir], mediaReadFile: readFile }),
        }),
      ).rejects.toThrow("Local media path is not under an allowed directory");
      expect(readFile).not.toHaveBeenCalled();
      expect(requests).toEqual([]);
    },
  );

  it.each([
    { name: "uppercase HTML and file URL", markdown: false, unquoted: false },
    { name: "Markdown and mixed-case file URL", markdown: true, unquoted: false },
    { name: "unquoted HTML source", markdown: false, unquoted: true },
  ])("uploads $name through the canonical parser", async ({ markdown, unquoted }) => {
    const source = unquoted
      ? fixture.photoPath
      : pathToFileURL(fixture.photoPath).href.replace(/^file:/, markdown ? "FiLe:" : "FILE:");
    await telegramOutbound.sendText!({
      cfg: richConfig(),
      to: "123",
      text: markdown ? `![Chart](${source})` : `<IMG src=${unquoted ? source : `"${source}"`}>`,
      mediaLocalRoots: [fixture.mediaDir],
    });
    expect(requests.map(({ method }) => method)).toEqual(["sendRichMessage"]);
    const fields = requests[0]!.fields;
    const photo = richMessage(fields).blocks[0];
    expect(photo?.type).toBe("photo");
    if (photo?.type !== "photo") {
      throw new Error("Expected an uploaded rich photo block");
    }
    const upload = resolveTelegramTestUpload({ ...fields, photo: photo.photo.media }, "photo");
    expect(Buffer.from(await upload.arrayBuffer())).toEqual(photoBytes);
  });

  it("keeps balanced parentheses and captions in local Markdown image destinations", async () => {
    const imageDir = path.join(allowedDir, "chart(1)");
    await fs.mkdir(imageDir);
    const imagePath = path.join(imageDir, "plot.png");
    await fs.writeFile(imagePath, photoBytes);
    const readFile = vi.fn(async (filePath: string) => fs.readFile(filePath));
    await telegramOutbound.sendText!({
      cfg: richConfig(),
      to: "123",
      text: `Before\n\n![Plot](${imagePath} "Figure 1")\n\nafter`,
      mediaAccess: { localRoots: [allowedDir], readFile },
    });

    expect(readFile).toHaveBeenCalledExactlyOnceWith(imagePath);
    expect(requests.map(({ method }) => method)).toEqual(["sendRichMessage"]);
    const fields = requests[0]!.fields;
    const blocks = richMessage(fields).blocks;
    expect(blocks).toMatchObject([
      { type: "paragraph", text: "Before" },
      { type: "photo", caption: { text: "Figure 1" } },
      { type: "paragraph", text: "after" },
    ]);
    const photo = blocks[1];
    if (photo?.type !== "photo") {
      throw new Error("Expected an uploaded rich photo block");
    }
    const upload = resolveTelegramTestUpload({ ...fields, photo: photo.photo.media }, "photo");
    expect(upload.name).toBe("plot.png");
    expect(Buffer.from(await upload.arrayBuffer())).toEqual(photoBytes);
  });

  it("uploads only local slideshow sources while leaving HTTPS media remote", async () => {
    const readFile = vi.fn(async (filePath: string) => fs.readFile(filePath));
    const secondPath = path.join(fixture.mediaDir, "second.png");
    await telegramOutbound.sendText!({
      cfg: richConfig(),
      to: "123",
      text: [
        "<tg-slideshow>",
        `<img src="${fixture.photoPath}"/>`,
        '<img src="https://example.com/remote.png"/>',
        `<img src="${secondPath}"/>`,
        "</tg-slideshow>",
      ].join(""),
      mediaAccess: { localRoots: [fixture.mediaDir], readFile },
    });
    expect(readFile.mock.calls.map(([source]) => source)).toEqual([fixture.photoPath, secondPath]);
    expect(requests.map(({ method }) => method)).toEqual(["sendRichMessage"]);
    const fields = requests[0]!.fields;
    const slideshow = richMessage(fields).blocks[0];
    if (slideshow?.type !== "slideshow") {
      throw new Error("Expected a rich slideshow block");
    }
    expect(slideshow.blocks).toMatchObject([
      { type: "photo" },
      { type: "photo", photo: { media: "https://example.com/remote.png" } },
      { type: "photo" },
    ]);
    const photos = slideshow.blocks.filter((block) => block.type === "photo");
    expect(
      [photos[0]!, photos[2]!].map(
        (photo) => resolveTelegramTestUpload({ ...fields, photo: photo.photo.media }, "photo").name,
      ),
    ).toEqual(["pixel.png", "second.png"]);
  });

  it.each(
    ["inline code", "fenced code", "HTML pre", "unsupported HTML"].flatMap((context) =>
      ["HTML", "Markdown"].map((syntax) => ({ context, syntax })),
    ),
  )(
    "leaves $syntax local-file examples in $context unread without changing text rendering",
    async ({ context, syntax }) => {
      const example =
        syntax === "HTML" ? `<img src="${fixture.photoPath}"/>` : `![Chart](${fixture.photoPath})`;
      const text =
        context === "inline code"
          ? `Keep \`${example}\` literal.`
          : context === "fenced code"
            ? `\`\`\`html\n${example}\n\`\`\``
            : context === "HTML pre"
              ? `<pre>${example}</pre>`
              : `<custom>${example}</custom>`;
      const readFile = vi.fn(async (filePath: string) => fs.readFile(filePath));
      await telegramOutbound.sendText!({
        cfg: richConfig(),
        to: "123",
        text,
        mediaAccess: { localRoots: [fixture.mediaDir], readFile },
      });
      expect(readFile).not.toHaveBeenCalled();
      expect(requests.map(({ method }) => method)).toEqual(["sendRichMessage"]);
      const fields = requests[0]!.fields;
      expect(Object.values(fields).some((value) => value instanceof File)).toBe(false);
      const blocks = richMessage(fields).blocks;
      const serialized = JSON.stringify(blocks);
      if (syntax === "Markdown" && (context === "HTML pre" || context === "unsupported HTML")) {
        // The existing Markdown IR renders image alternatives inside HTML as text.
        expect(blocks).toEqual([
          context === "HTML pre"
            ? { type: "pre", text: "Chart" }
            : { type: "paragraph", text: "<custom>Chart</custom>" },
        ]);
      } else {
        expect(serialized).toContain(JSON.stringify(example).slice(1, -1));
      }
      expect(serialized).not.toContain("tg://photo");
      expect(serialized).not.toContain('"type":"photo"');
    },
  );

  it.each([1, 2])(
    "delivers %i local payload images with text in one rich message",
    async (count) => {
      const mediaUrls = [fixture.photoPath, path.join(fixture.mediaDir, "second.png")].slice(
        0,
        count,
      );
      const result = await telegramOutbound.sendPayload!({
        cfg: richConfig(),
        to: "123",
        text: "",
        payload: { text: "Report", mediaUrls },
        mediaLocalRoots: [fixture.mediaDir],
      });
      expect(requests.map(({ method }) => method)).toEqual(["sendRichMessage"]);
      const fields = requests[0]!.fields;
      const blocks = richMessage(fields).blocks;
      expect(blocks[0]).toMatchObject({ type: "paragraph", text: "Report" });
      const photos = blocks.filter((block) => block.type === "photo");
      expect(photos).toHaveLength(count);
      const uploads = photos.map((block) =>
        resolveTelegramTestUpload({ ...fields, photo: block.photo.media }, "photo"),
      );
      expect(uploads.map((upload) => upload.name)).toEqual(
        ["pixel.png", "second.png"].slice(0, count),
      );
      for (const upload of uploads) {
        expect(Buffer.from(await upload.arrayBuffer())).toEqual(photoBytes);
      }
      expect(result.receipt?.platformMessageIds ?? [result.messageId]).toEqual(["1"]);
      expect(result.receipt?.primaryPlatformMessageId ?? result.messageId).toBe("1");
    },
  );

  it("delivers payload media swallowed by an unclosed code fence through the native route", async () => {
    const result = await telegramOutbound.sendPayload!({
      cfg: richConfig(),
      to: "123",
      text: "",
      payload: { text: "```text\nexample", mediaUrls: [fixture.photoPath] },
      mediaLocalRoots: [fixture.mediaDir],
    });
    expect(requests.map(({ method }) => method)).toEqual(["sendPhoto"]);
    const fields = requests[0]!.fields;
    const upload = resolveTelegramTestUpload(fields, "photo");
    expect(Buffer.from(await upload.arrayBuffer())).toEqual(photoBytes);
    expect(fields.caption).toContain("example");
    expect(fields.caption).not.toContain("tg://");
    expect(fields.caption).not.toContain("figure");
    expect(result.receipt?.platformMessageIds ?? [result.messageId]).toEqual(["1"]);
  });

  it("keeps a text-free local payload on the native album route", async () => {
    const result = await telegramOutbound.sendPayload!({
      cfg: richConfig(),
      to: "123",
      text: "",
      payload: { mediaUrls: [fixture.photoPath, path.join(fixture.mediaDir, "second.png")] },
      mediaLocalRoots: [fixture.mediaDir],
    });
    expect(requests.map(({ method }) => method)).toEqual(["sendMediaGroup"]);
    const fields = requests[0]!.fields;
    const media = JSON.parse(String(fields.media)) as Array<{ type: string; media: string }>;
    expect(media.map((item) => item.type)).toEqual(["photo", "photo"]);
    expect(
      media.map(
        (item) => resolveTelegramTestUpload({ ...fields, photo: item.media }, "photo").name,
      ),
    ).toEqual(["pixel.png", "second.png"]);
    expect(result.receipt?.platformMessageIds).toEqual(["1001", "1002"]);
  });

  it("preserves remaining attachment order and consumes an implicit reply only once", async () => {
    const result = await telegramOutbound.sendPayload!({
      cfg: richConfig(),
      to: "123",
      text: "",
      payload: {
        text: "Report",
        mediaUrls: [documentPath, voicePath, secondDocumentPath],
      },
      mediaLocalRoots: [fixture.mediaDir],
      replyToId: "900",
      replyToIdSource: "implicit",
      replyToMode: "first",
    });
    expect(requests.map(({ method }) => method)).toEqual([
      "sendRichMessage",
      "sendDocument",
      "sendDocument",
    ]);
    const rich = richMessage(requests[0]!.fields);
    expect(rich.blocks).toMatchObject([
      { type: "paragraph", text: "Report" },
      { type: "voice_note" },
    ]);
    expect(JSON.parse(String(requests[0]!.fields.reply_parameters))).toMatchObject({
      message_id: 900,
    });
    expect(
      requests.slice(1).map(({ fields }) => resolveTelegramTestUpload(fields, "document").name),
    ).toEqual(["notes.pdf", "appendix.pdf"]);
    for (const { fields } of requests.slice(1)) {
      expect(fields.reply_parameters).toBeUndefined();
      expect(fields.reply_to_message_id).toBeUndefined();
    }
    expect(result.receipt?.platformMessageIds).toEqual(["1", "2", "3"]);
  });

  it.each(["voice", "video note", "forced document"] as const)(
    "preserves explicit %s delivery through the ordinary media route",
    async (mode) => {
      const source =
        mode === "voice" ? voicePath : mode === "video note" ? videoPath : fixture.photoPath;
      const result = await telegramOutbound.sendPayload!({
        cfg: richConfig(),
        to: "123",
        text: "",
        payload: {
          text: mode === "video note" ? "" : "Caption",
          mediaUrls: [source],
          ...(mode === "voice" ? { audioAsVoice: true } : {}),
          ...(mode === "video note" ? { videoAsNote: true } : {}),
        },
        ...(mode === "forced document" ? { forceDocument: true } : {}),
        mediaLocalRoots: [fixture.mediaDir],
      });
      const method =
        mode === "voice" ? "sendVoice" : mode === "video note" ? "sendVideoNote" : "sendDocument";
      const key = mode === "voice" ? "voice" : mode === "video note" ? "video_note" : "document";
      expect(requests.map((request) => request.method)).toEqual([method]);
      const upload = resolveTelegramTestUpload(requests[0]!.fields, key);
      expect(upload.name).toBe(path.basename(source));
      expect(Buffer.from(await upload.arrayBuffer())).toEqual(await fs.readFile(source));
      expect(result.receipt?.platformMessageIds ?? [result.messageId]).toEqual(["1"]);
    },
  );

  it.each(["photo", "voice"] as const)(
    "preserves the original local %s and both receipts after rich rejection",
    async (kind) => {
      rejections.push("Bad Request: RICH_MESSAGE_MEDIA_INVALID");
      const source = kind === "photo" ? fixture.photoPath : voicePath;
      const result = await telegramOutbound.sendPayload!({
        cfg: richConfig(),
        to: "123",
        text: "",
        payload: {
          text: "Report",
          mediaUrls: [source],
          channelData: { telegram: { buttons: fixture.buttons } },
        },
        mediaLocalRoots: [fixture.mediaDir],
        replyToId: "900",
        replyToIdSource: "implicit",
        replyToMode: "first",
      });
      const method = kind === "photo" ? "sendPhoto" : "sendVoice";
      const key = kind === "photo" ? "photo" : "voice";
      expect(requests.map((request) => request.method)).toEqual([
        "sendRichMessage",
        "sendMessage",
        method,
      ]);
      expect(requests[1]!.fields.text).toBe(`Report\n${path.basename(source)}`);
      expect(requests[1]!.fields.reply_markup).toEqual({ inline_keyboard: fixture.buttons });
      expect(requests[1]!.fields.reply_to_message_id).toBe(900);
      expect(requests[1]!.fields.allow_sending_without_reply).toBe(true);
      const fallback = requests[2]!.fields;
      expect(fallback.reply_markup).toBeUndefined();
      expect(fallback.reply_parameters).toBeUndefined();
      expect(fallback.reply_to_message_id).toBeUndefined();
      expect(Buffer.from(await resolveTelegramTestUpload(fallback, key).arrayBuffer())).toEqual(
        await fs.readFile(source),
      );
      expect(result.receipt?.platformMessageIds).toEqual(["2", "3"]);
    },
  );

  it("retains the accepted plain-text receipt when local fallback upload fails", async () => {
    rejections.push("Bad Request: RICH_MESSAGE_MEDIA_INVALID", "", "Bad Request: upload rejected");
    const observed = await telegramOutbound.sendText!({
      cfg: richConfig(),
      to: "123",
      text: `<img src="${fixture.photoPath}"/>`,
      mediaLocalRoots: [fixture.mediaDir],
    }).catch((error: unknown) => error);
    expect(requests.map(({ method }) => method)).toEqual([
      "sendRichMessage",
      "sendMessage",
      "sendPhoto",
    ]);
    expect(requests[1]!.fields.text).toBe("pixel.png");
    expect(isChannelPartialDeliveryError(observed)).toBe(true);
    if (!isChannelPartialDeliveryError(observed)) {
      throw observed;
    }
    expect(observed.deliveryResult.messageIds).toEqual(["2"]);
    expect(observed.deliveryResult.visibleReplySent).toBe(true);
  });
});
