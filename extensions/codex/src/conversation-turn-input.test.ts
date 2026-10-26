import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  deriveInboundMessageHookContext,
  toPluginMessageReceivedEvent,
} from "openclaw/plugin-sdk/hook-runtime";
import type { PluginHookMediaFact } from "openclaw/plugin-sdk/plugin-entry";
import { expect, it } from "vitest";
import type { CodexUserInput } from "./app-server/protocol.js";
import { buildCodexConversationTurnInput } from "./conversation-turn-input.js";

function expectImages(
  media: PluginHookMediaFact[],
  images: CodexUserInput[],
  overrides: Partial<ReturnType<typeof deriveInboundMessageHookContext>> = {},
) {
  const canonical = {
    ...deriveInboundMessageHookContext({ media, CommandAuthorized: false }),
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
const png = (file: string): PluginHookMediaFact => ({ path: file, contentType: "image/png" });

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

it("uses staged remote-cache paths instead of original iMessage attachment paths", () => {
  const rawPath = "/Users/demo/Library/Messages/Attachments/ab/cd/photo.jpg";
  const stagedPath = "/tmp/openclaw-proof/.openclaw/media/remote-cache/imessage/photo.jpg";
  expectImages([{ path: stagedPath, contentType: "image/jpeg" }], [localImage(stagedPath)], {
    channelId: "imessage",
    originalMedia: [{ path: rawPath, contentType: "image/jpeg" }],
  });
});

const photo = "/tmp/photo.png";
const windows = "C:\\QA test\\a.png";
const second = path.resolve("OpenClaw QA", "second.jpg");
it.each([
  ["duplicate attachments", [png(photo), png(photo)], [localImage(photo), localImage(photo)]],
  ["kind-only", [{ path: "/tmp/photo", kind: "image" }], [localImage("/tmp/photo")]],
  ["protocol-relative", [{ url: "//cdn.test/a.webp" }], [remoteImage("//cdn.test/a.webp")]],
  ["Windows", [{ url: windows, contentType: "image/png" }], [localImage(windows)]],
  ["malformed encoding", [{ url: "FiLe:///tmp/%zz/photo.png", contentType: "image/png" }], []],
  ["encoded separator", [{ url: "FiLe:///tmp/hidden%2Fphoto.png", contentType: "image/png" }], []],
  [
    "local URLs",
    [
      { url: "/tmp/staged-photo.png", contentType: "image/png" },
      { url: pathToFileURL(second).href, contentType: "image/jpeg" },
    ],
    [localImage("/tmp/staged-photo.png"), localImage(second)],
  ],
] satisfies [string, PluginHookMediaFact[], CodexUserInput[]][])(
  "handles %s",
  (_label, media, images) => {
    expectImages(media, images);
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

it.skipIf(process.platform === "win32")("preserves POSIX backslash filenames in file URLs", () => {
  expectImages(
    [{ url: "FiLe:///tmp/photo%5Cname.png", contentType: "image/png" }],
    [localImage("/tmp/photo\\name.png")],
  );
});
