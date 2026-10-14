import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  deriveInboundMessageHookContext,
  toPluginMessageReceivedEvent,
} from "openclaw/plugin-sdk/hook-runtime";
import type { PluginHookMediaFact } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it } from "vitest";
import type { CodexUserInput } from "./app-server/protocol.js";
import { buildCodexConversationTurnInput } from "./conversation-turn-input.js";

function expectImages(
  media: PluginHookMediaFact[],
  images: CodexUserInput[],
  overrides: Partial<ReturnType<typeof deriveInboundMessageHookContext>> = {},
) {
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
  expect(
    buildCodexConversationTurnInput({
      prompt: "look",
      event: {
        ...toPluginMessageReceivedEvent(canonical),
        channel: canonical.channelId,
        isGroup: canonical.isGroup,
      },
    }),
  ).toEqual([{ type: "text", text: "look", text_elements: [] }, ...images]);
}

describe("codex conversation turn input", () => {
  it("forwards a projected image once despite scalar and plural metadata aliases", () => {
    expectImages(
      [{ path: "/tmp/photo.png", url: "https://example.test/photo.png", contentType: "image/png" }],
      [{ type: "localImage", path: "/tmp/photo.png" }],
    );
  });

  it("preserves sparse mixed media associations and source order", () => {
    const inlineImage = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";
    expectImages(
      [
        { url: "https://example.test/first.webp" },
        {},
        { path: "/tmp/voice", contentType: "audio/ogg" },
        { path: "/tmp/photo", contentType: "image/png" },
        { url: inlineImage, contentType: "image/gif" },
      ],
      [
        { type: "image", url: "https://example.test/first.webp" },
        { type: "localImage", path: "/tmp/photo" },
        { type: "image", url: inlineImage },
      ],
    );
  });

  it("preserves separately attached copies of the same image", () => {
    expectImages(
      [
        { path: "/tmp/photo.png", contentType: "image/png" },
        { path: "/tmp/photo.png", contentType: "image/png" },
      ],
      [
        { type: "localImage", path: "/tmp/photo.png" },
        { type: "localImage", path: "/tmp/photo.png" },
      ],
    );
  });

  it("uses staged remote-cache paths instead of original iMessage attachment paths", () => {
    const rawPath = "/Users/demo/Library/Messages/Attachments/ab/cd/photo.jpg";
    const stagedPath = "/tmp/openclaw-proof/.openclaw/media/remote-cache/imessage/photo.jpg";
    expectImages(
      [{ path: stagedPath, contentType: "image/jpeg" }],
      [{ type: "localImage", path: stagedPath }],
      { channelId: "imessage", originalMedia: [{ path: rawPath, contentType: "image/jpeg" }] },
    );
  });

  it("withholds attachments while remote staging is pending", () => {
    expectImages(
      [{ path: "/Users/demo/Library/Messages/Attachments/photo.jpg", contentType: "image/jpeg" }],
      [],
      { channelId: "imessage", mediaStagingPending: true },
    );
  });

  it.each([
    {
      media: { path: "/tmp/photo", kind: "image" },
      image: { type: "localImage", path: "/tmp/photo" },
      label: "image kind without MIME type or extension",
    },
    {
      media: { url: "//cdn.example.test/photo.webp" },
      image: { type: "image", url: "//cdn.example.test/photo.webp" },
      label: "protocol-relative remote URL",
    },
    {
      media: { url: "C:\\OpenClaw QA\\photo.png", contentType: "image/png" },
      image: { type: "localImage", path: "C:\\OpenClaw QA\\photo.png" },
      label: "Windows local path",
    },
  ] satisfies { media: PluginHookMediaFact; image: CodexUserInput; label: string }[])(
    "recognizes $label",
    ({ media, image }) => {
      expectImages([media], [image]);
    },
  );

  it.each(["path", "url"] as const)(
    "decodes mixed-case file URLs from %s for local images",
    (field) => {
      const imagePath = path.resolve("OpenClaw QA", "photo #1?.png");
      expectImages(
        [
          {
            [field]: pathToFileURL(imagePath).href.replace(/^file:/, "FiLe:"),
            contentType: "image/png",
          },
        ],
        [{ type: "localImage", path: imagePath }],
      );
    },
  );

  it.each([
    { label: "malformed encoding", url: "FiLe:///tmp/%zz/photo.png" },
    { label: "encoded separators", url: "FiLe:///tmp/hidden%2Fphoto.png" },
  ])("rejects file URLs with $label", ({ url }) => {
    expectImages([{ url, contentType: "image/png" }], []);
  });

  it.skipIf(process.platform === "win32")(
    "preserves POSIX backslash filenames in file URLs",
    () => {
      expectImages(
        [{ url: "FiLe:///tmp/photo%5Cname.png", contentType: "image/png" }],
        [{ type: "localImage", path: "/tmp/photo\\name.png" }],
      );
    },
  );

  it("treats local media URLs as Codex local image input", () => {
    const secondImagePath = path.resolve("OpenClaw QA", "second.jpg");
    expectImages(
      [
        { url: "/tmp/staged-photo.png", contentType: "image/png" },
        { url: pathToFileURL(secondImagePath).href, contentType: "image/jpeg" },
      ],
      [
        { type: "localImage", path: "/tmp/staged-photo.png" },
        { type: "localImage", path: secondImagePath },
      ],
    );
  });
});
