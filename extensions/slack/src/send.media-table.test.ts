import { describe, expect, it, vi } from "vitest";
import type { WebClient } from "@slack/web-api";

// --- Mock state (hoisted before any vi.mock) ---
const testState = vi.hoisted(() => ({
  account: {
    accountId: "default",
    botToken: "xoxb-test",
    botTokenSource: "config",
    config: {},
  },
  config: {},
}));

// --- Module mocks ---
vi.mock("openclaw/plugin-sdk/config-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/config-runtime")>();
  return {
    ...actual,
    loadConfig: () => testState.config,
  };
});

vi.mock("./accounts.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./accounts.js")>();
  return {
    ...actual,
    resolveSlackAccount: () => testState.account,
  };
});

vi.mock("openclaw/plugin-sdk/web-media", () => ({
  loadWebMedia: vi.fn(async () => ({
    buffer: Buffer.from("fake-image-data"),
    contentType: "image/png",
    fileName: "image.png",
  })),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: vi.fn(async () => ({
    response: { ok: true },
    release: async () => {},
  })),
}));

const { sendMessageSlack } = await import("./send.js");

type MediaTestClient = WebClient & {
  conversations: { open: ReturnType<typeof vi.fn> };
  chat: { postMessage: ReturnType<typeof vi.fn> };
  files: {
    getUploadURLExternal: ReturnType<typeof vi.fn>;
    completeUploadExternal: ReturnType<typeof vi.fn>;
  };
};

function createMediaTestClient(): MediaTestClient {
  return {
    conversations: {
      open: vi.fn(async () => ({ channel: { id: "D123" } })),
    },
    chat: {
      postMessage: vi.fn(async () => ({ ts: "171234.567" })),
    },
    files: {
      getUploadURLExternal: vi.fn(async () => ({
        ok: true,
        upload_url: "https://files.slack.com/upload/v1/fake",
        file_id: "F_FAKE123",
      })),
      completeUploadExternal: vi.fn(async () => ({ ok: true })),
    },
  } as unknown as MediaTestClient;
}

describe("sendMessageSlack media + Block Kit table deduplication", () => {
  it("does not duplicate fallback text when media upload consumes the only chunk", async () => {
    const client = createMediaTestClient();
    // A table-only message with a media attachment
    const tableMessage = "| Name | Age |\n|------|-----|\n| Alice | 30 |";

    await sendMessageSlack("channel:C123", tableMessage, {
      token: "xoxb-test",
      client,
      mediaUrl: "https://example.com/photo.png",
      tableMode: "block",
    });

    // The file upload should have been called (media path)
    expect(client.files.getUploadURLExternal).toHaveBeenCalled();
    expect(client.files.completeUploadExternal).toHaveBeenCalled();

    // Check the follow-up message that carries the table attachment:
    // it should NOT contain the full fallback text (which was already
    // used as the media upload caption).
    const postCalls = client.chat.postMessage.mock.calls;
    if (postCalls.length > 0) {
      // The follow-up attachment message should use NBSP, not full table text
      const attachmentCall = postCalls.find(
        (call) => (call[0] as { attachments?: unknown[] }).attachments,
      );
      if (attachmentCall) {
        const text = (attachmentCall[0] as { text?: string }).text ?? "";
        // Should be a non-breaking space, not the rendered table
        expect(text).toBe("\u00a0");
        // Should have the Block Kit table attachment
        const attachments = (attachmentCall[0] as { attachments?: unknown[] }).attachments;
        expect(attachments).toBeDefined();
        expect(attachments!.length).toBeGreaterThan(0);
      }
    }
  });

  it("still attaches Block Kit table when media + single table are combined", async () => {
    const client = createMediaTestClient();
    const tableMessage = "| X | Y |\n|---|---|\n| 1 | 2 |";

    await sendMessageSlack("channel:C123", tableMessage, {
      token: "xoxb-test",
      client,
      mediaUrl: "https://example.com/img.png",
      tableMode: "block",
    });

    // Should have a postMessage call with table attachments
    const postCalls = client.chat.postMessage.mock.calls;
    const hasTableAttachment = postCalls.some((call) => {
      const payload = call[0] as { attachments?: { blocks?: { type: string }[] }[] };
      return payload.attachments?.some((att) => att.blocks?.some((b) => b.type === "table"));
    });
    expect(hasTableAttachment).toBe(true);
  });
});
