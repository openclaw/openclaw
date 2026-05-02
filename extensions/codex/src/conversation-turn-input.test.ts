import { describe, expect, it } from "vitest";
import { buildCodexConversationTurnInput } from "./conversation-turn-input.js";

describe("codex conversation turn input", () => {
  it("forwards inbound image attachments to Codex app-server", () => {
    expect(
      buildCodexConversationTurnInput({
        prompt: "what is this?",
        event: {
          content: "what is this?",
          channel: "telegram",
          isGroup: false,
          metadata: {
            mediaPaths: ["/tmp/photo.png", "/tmp/readme.txt"],
            mediaUrls: ["https://example.test/photo.png"],
            mediaTypes: ["image/png", "text/plain"],
          },
        },
      }),
    ).toEqual([
      { type: "text", text: "what is this?", text_elements: [] },
      { type: "localImage", path: "/tmp/photo.png" },
    ]);
  });

  it("uses remote image urls when no local path is available", () => {
    expect(
      buildCodexConversationTurnInput({
        prompt: "look",
        event: {
          content: "look",
          channel: "webchat",
          isGroup: false,
          metadata: {
            mediaUrl: "https://example.test/photo.webp?sig=1",
          },
        },
      }),
    ).toEqual([
      { type: "text", text: "look", text_elements: [] },
      { type: "image", url: "https://example.test/photo.webp?sig=1" },
    ]);
  });

  it("decodes local file urls before forwarding image attachments", () => {
    expect(
      buildCodexConversationTurnInput({
        prompt: "look",
        event: {
          content: "look",
          channel: "webchat",
          isGroup: false,
          metadata: {
            mediaPath: "file:///tmp/photo%20one.png",
            mediaType: "image/png",
          },
        },
      }),
    ).toEqual([
      { type: "text", text: "look", text_elements: [] },
      {
        type: "localImage",
        path: expect.stringMatching(/[\\/]tmp[\\/]photo one\.png$/),
      },
    ]);
  });

  it("falls back to remote image urls when local file urls are not usable", () => {
    expect(
      buildCodexConversationTurnInput({
        prompt: "look",
        event: {
          content: "look",
          channel: "webchat",
          isGroup: false,
          metadata: {
            mediaPath: "file://example.test/share/photo.png",
            mediaUrl: "https://example.test/photo.png",
            mediaType: "image/png",
          },
        },
      }),
    ).toEqual([
      { type: "text", text: "look", text_elements: [] },
      { type: "image", url: "https://example.test/photo.png" },
    ]);
  });

  it("ignores malformed local file urls without failing the turn input", () => {
    expect(
      buildCodexConversationTurnInput({
        prompt: "look",
        event: {
          content: "look",
          channel: "webchat",
          isGroup: false,
          metadata: {
            mediaPath: "file:///tmp/%E0%A4%A.png",
            mediaType: "image/png",
          },
        },
      }),
    ).toEqual([{ type: "text", text: "look", text_elements: [] }]);
  });
});
