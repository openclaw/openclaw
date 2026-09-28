import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  deriveInboundMessageHookContext,
  toPluginMessageReceivedEvent,
} from "openclaw/plugin-sdk/hook-runtime";
import type {
  PluginHookInboundClaimEvent,
  PluginHookMediaFact,
} from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it } from "vitest";
import { buildCodexConversationTurnInput } from "./conversation-turn-input.js";

const localFileCases = ["file", "FILE", "FiLe"].flatMap((scheme) =>
  (["path", "url"] as const).map((field) => ({ scheme, field })),
);

function projectInboundEvent(
  media: PluginHookMediaFact[],
  overrides: Partial<ReturnType<typeof deriveInboundMessageHookContext>> = {},
): PluginHookInboundClaimEvent {
  const canonical = {
    ...deriveInboundMessageHookContext({
      Body: "look",
      From: "user",
      Provider: "webchat",
      CommandAuthorized: false,
      media,
    }),
    ...overrides,
  };
  // Both inbound hooks share the production media projection, including legacy aliases.
  return {
    ...toPluginMessageReceivedEvent(canonical),
    channel: canonical.channelId,
    isGroup: canonical.isGroup,
  };
}

function buildInput(event: PluginHookInboundClaimEvent) {
  return buildCodexConversationTurnInput({ prompt: "look", event });
}

const textInput = { type: "text", text: "look", text_elements: [] };

describe("codex conversation turn input", () => {
  it("forwards a projected image once despite scalar and plural metadata aliases", () => {
    const event = projectInboundEvent([
      {
        path: "/tmp/photo.png",
        url: "https://example.test/photo.png",
        contentType: "image/png",
      },
    ]);

    expect(buildInput(event)).toEqual([textInput, { type: "localImage", path: "/tmp/photo.png" }]);
  });

  it("preserves sparse mixed media associations and source order", () => {
    const inlineImage = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";
    const event = projectInboundEvent([
      { url: "https://example.test/first.webp" },
      {},
      { path: "/tmp/voice", contentType: "audio/ogg" },
      { path: "/tmp/photo", contentType: "image/png" },
      { url: inlineImage, contentType: "image/gif" },
    ]);

    expect(buildInput(event)).toEqual([
      textInput,
      { type: "image", url: "https://example.test/first.webp" },
      { type: "localImage", path: "/tmp/photo" },
      { type: "image", url: inlineImage },
    ]);
  });

  it("preserves separately attached copies of the same image", () => {
    const event = projectInboundEvent([
      { path: "/tmp/photo.png", contentType: "image/png" },
      { path: "/tmp/photo.png", contentType: "image/png" },
    ]);

    expect(buildInput(event)).toEqual([
      textInput,
      { type: "localImage", path: "/tmp/photo.png" },
      { type: "localImage", path: "/tmp/photo.png" },
    ]);
  });

  it("uses staged remote-cache paths instead of original iMessage attachment paths", () => {
    const rawPath = "/Users/demo/Library/Messages/Attachments/ab/cd/photo.jpg";
    const stagedPath = "/tmp/openclaw-proof/.openclaw/media/remote-cache/imessage/photo.jpg";
    const event = projectInboundEvent([{ path: stagedPath, contentType: "image/jpeg" }], {
      channelId: "imessage",
      originalMedia: [{ path: rawPath, contentType: "image/jpeg" }],
    });

    expect(buildInput(event)).toEqual([textInput, { type: "localImage", path: stagedPath }]);
  });

  it("withholds attachments while remote staging is pending", () => {
    const event = projectInboundEvent(
      [{ path: "/Users/demo/Library/Messages/Attachments/photo.jpg", contentType: "image/jpeg" }],
      { channelId: "imessage", mediaStagingPending: true },
    );

    expect(buildInput(event)).toEqual([textInput]);
  });

  it("recognizes an image kind without a MIME type or file extension", () => {
    expect(buildInput(projectInboundEvent([{ path: "/tmp/photo", kind: "image" }]))).toEqual([
      textInput,
      { type: "localImage", path: "/tmp/photo" },
    ]);
  });

  it("keeps protocol-relative image URLs remote", () => {
    expect(buildInput(projectInboundEvent([{ url: "//cdn.example.test/photo.webp" }]))).toEqual([
      textInput,
      { type: "image", url: "//cdn.example.test/photo.webp" },
    ]);
  });

  it.each(localFileCases)(
    "decodes $scheme URLs from $field for local images",
    ({ scheme, field }) => {
      const imagePath = path.resolve("OpenClaw QA", "photo #1?.png");
      const event = projectInboundEvent([
        {
          [field]: pathToFileURL(imagePath).href.replace(/^file:/, `${scheme}:`),
          contentType: "image/png",
        },
      ]);

      expect(buildInput(event)).toEqual([textInput, { type: "localImage", path: imagePath }]);
    },
  );

  it.each(localFileCases)("drops malformed $scheme URLs from $field", ({ scheme, field }) => {
    const event = projectInboundEvent([
      { [field]: `${scheme}:///tmp/%zz/photo.png`, contentType: "image/png" },
    ]);

    expect(buildInput(event)).toEqual([textInput]);
  });

  it.each(localFileCases)(
    "rejects encoded separators in $scheme URLs from $field",
    ({ scheme, field }) => {
      const event = projectInboundEvent([
        { [field]: `${scheme}:///tmp/hidden%2Fphoto.png`, contentType: "image/png" },
      ]);

      expect(buildInput(event)).toEqual([textInput]);
    },
  );

  it.skipIf(process.platform === "win32").each(localFileCases)(
    "preserves POSIX backslash filenames in $scheme URLs from $field",
    ({ scheme, field }) => {
      const event = projectInboundEvent([
        { [field]: `${scheme}:///tmp/photo%5Cname.png`, contentType: "image/png" },
      ]);

      expect(buildInput(event)).toEqual([
        textInput,
        { type: "localImage", path: "/tmp/photo\\name.png" },
      ]);
    },
  );

  it("treats local media URLs as Codex local image input", () => {
    const secondImagePath = path.resolve("OpenClaw QA", "second.jpg");
    const event = projectInboundEvent([
      { url: "/tmp/staged-photo.png", contentType: "image/png" },
      { url: pathToFileURL(secondImagePath).href, contentType: "image/jpeg" },
    ]);

    expect(buildInput(event)).toEqual([
      textInput,
      { type: "localImage", path: "/tmp/staged-photo.png" },
      { type: "localImage", path: secondImagePath },
    ]);
  });

  it("treats Windows media paths as Codex local image input", () => {
    const event = projectInboundEvent([
      { url: "C:\\OpenClaw QA\\photo.png", contentType: "image/png" },
    ]);

    expect(buildInput(event)).toEqual([
      textInput,
      { type: "localImage", path: "C:\\OpenClaw QA\\photo.png" },
    ]);
  });
});
