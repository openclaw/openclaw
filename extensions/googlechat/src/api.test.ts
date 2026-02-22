import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolvedGoogleChatAccount } from "./accounts.js";
import { convertMarkdownToGoogleChat, downloadGoogleChatMedia } from "./api.js";

vi.mock("./auth.js", () => ({
  getGoogleChatAccessToken: vi.fn().mockResolvedValue("token"),
}));

const account = {
  accountId: "default",
  enabled: true,
  credentialSource: "inline",
  config: {},
} as ResolvedGoogleChatAccount;

describe("convertMarkdownToGoogleChat", () => {
  it("converts **bold** to *bold*", () => {
    expect(convertMarkdownToGoogleChat("This is **bold** text")).toBe("This is *bold* text");
  });

  it("converts ~~strikethrough~~ to ~strikethrough~", () => {
    expect(convertMarkdownToGoogleChat("This is ~~strikethrough~~ text")).toBe(
      "This is ~strikethrough~ text",
    );
  });

  it("preserves _italic_ formatting (already compatible)", () => {
    expect(convertMarkdownToGoogleChat("This is _italic_ text")).toBe("This is _italic_ text");
  });

  it("handles multiple formatting in same text", () => {
    expect(convertMarkdownToGoogleChat("**Bold** and ~~strike~~ and _italic_")).toBe(
      "*Bold* and ~strike~ and _italic_",
    );
  });

  it("handles nested formatting", () => {
    expect(convertMarkdownToGoogleChat("**bold with ~~strike~~ inside**")).toBe(
      "*bold with ~strike~ inside*",
    );
  });

  it("preserves plain text without formatting", () => {
    expect(convertMarkdownToGoogleChat("Plain text without formatting")).toBe(
      "Plain text without formatting",
    );
  });

  it("handles empty string", () => {
    expect(convertMarkdownToGoogleChat("")).toBe("");
  });

  it("handles multiple bold segments", () => {
    expect(convertMarkdownToGoogleChat("**one** and **two** and **three**")).toBe(
      "*one* and *two* and *three*",
    );
  });

  it("preserves inline code with ** inside", () => {
    expect(convertMarkdownToGoogleChat("Use `**glob**` pattern")).toBe("Use `**glob**` pattern");
  });

  it("preserves fenced code blocks with ** inside", () => {
    const input = "Before\n```\n**not bold**\n~~not strike~~\n```\nAfter **bold**";
    const expected = "Before\n```\n**not bold**\n~~not strike~~\n```\nAfter *bold*";
    expect(convertMarkdownToGoogleChat(input)).toBe(expected);
  });

  it("preserves code blocks with language tag", () => {
    const input = "```js\nconst x = '**test**';\n```";
    expect(convertMarkdownToGoogleChat(input)).toBe(input);
  });

  it("handles mixed prose and code", () => {
    const input = "**bold** then `**code**` then **more bold**";
    const expected = "*bold* then `**code**` then *more bold*";
    expect(convertMarkdownToGoogleChat(input)).toBe(expected);
  });
});

describe("downloadGoogleChatMedia", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects when content-length exceeds max bytes", async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.close();
      },
    });
    const response = new Response(body, {
      status: 200,
      headers: { "content-length": "50", "content-type": "application/octet-stream" },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

    await expect(
      downloadGoogleChatMedia({ account, resourceName: "media/123", maxBytes: 10 }),
    ).rejects.toThrow(/max bytes/i);
  });

  it("rejects when streamed payload exceeds max bytes", async () => {
    const chunks = [new Uint8Array(6), new Uint8Array(6)];
    let index = 0;
    const body = new ReadableStream({
      pull(controller) {
        if (index < chunks.length) {
          controller.enqueue(chunks[index++]);
        } else {
          controller.close();
        }
      },
    });
    const response = new Response(body, {
      status: 200,
      headers: { "content-type": "application/octet-stream" },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

    await expect(
      downloadGoogleChatMedia({ account, resourceName: "media/123", maxBytes: 10 }),
    ).rejects.toThrow(/max bytes/i);
  });
});
