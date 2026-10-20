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

const localImage = (imagePath: string): CodexUserInput => ({ type: "localImage", path: imagePath });
const remoteImage = (url: string): CodexUserInput => ({ type: "image", url });
const png = (imagePath: string): PluginHookMediaFact => ({
  path: imagePath,
  contentType: "image/png",
});

describe("codex conversation turn input", () => {
  it("preserves sparse mixed media associations and source order", () => {
    const inlineImage = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";
    expectImages(
      [
        { url: "https://example.test/first.webp" },
        {},
        { path: "/tmp/voice", contentType: "audio/ogg" },
        { path: "/tmp/photo", url: "https://example.test/photo.png", contentType: "image/png" },
        { url: inlineImage, contentType: "image/gif" },
      ],
      [
        remoteImage("https://example.test/first.webp"),
        localImage("/tmp/photo"),
        remoteImage(inlineImage),
      ],
    );
  });

  it("preserves separately attached copies of the same image", () => {
    expectImages(
      [png("/tmp/photo.png"), png("/tmp/photo.png")],
      [localImage("/tmp/photo.png"), localImage("/tmp/photo.png")],
    );
  });

  it("uses staged remote-cache paths instead of original iMessage attachment paths", () => {
    const rawPath = "/Users/demo/Library/Messages/Attachments/ab/cd/photo.jpg";
    const stagedPath = "/tmp/openclaw-proof/.openclaw/media/remote-cache/imessage/photo.jpg";
    expectImages([{ path: stagedPath, contentType: "image/jpeg" }], [localImage(stagedPath)], {
      channelId: "imessage",
      originalMedia: [{ path: rawPath, contentType: "image/jpeg" }],
    });
  });

  it.each([
    [
      "image kind without MIME type or extension",
      { path: "/tmp/photo", kind: "image" },
      localImage("/tmp/photo"),
    ],
    [
      "protocol-relative remote URL",
      { url: "//cdn.example.test/photo.webp" },
      remoteImage("//cdn.example.test/photo.webp"),
    ],
    [
      "Windows local path",
      { url: "C:\\OpenClaw QA\\photo.png", contentType: "image/png" },
      localImage("C:\\OpenClaw QA\\photo.png"),
    ],
  ] satisfies [string, PluginHookMediaFact, CodexUserInput][])(
    "recognizes %s",
    (_label, media, image) => {
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
        [localImage(imagePath)],
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
        [localImage("/tmp/photo\\name.png")],
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
      [localImage("/tmp/staged-photo.png"), localImage(secondImagePath)],
    );
  });
});
