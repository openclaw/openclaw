import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SILENT_REPLY_TOKEN, type PluginRuntime } from "openclaw/plugin-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredConversationReference } from "./conversation-store.js";
const graphUploadMockState = vi.hoisted(() => ({
  uploadAndShareOneDrive: vi.fn(),
}));

vi.mock("./graph-upload.js", async () => {
  const actual = await vi.importActual<typeof import("./graph-upload.js")>("./graph-upload.js");
  return {
    ...actual,
    uploadAndShareOneDrive: graphUploadMockState.uploadAndShareOneDrive,
  };
});

import { resolvePreferredOpenClawTmpDir } from "../../../src/infra/tmp-openclaw-dir.js";
import {
  type MSTeamsAdapter,
  renderReplyPayloadsToMessages,
  sendMSTeamsMessages,
} from "./messenger.js";
import { setMSTeamsRuntime } from "./runtime.js";

const chunkMarkdownText = (text: string, limit: number) => {
  if (!text) {
    return [];
  }
  if (limit <= 0 || text.length <= limit) {
    return [text];
  }
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += limit) {
    chunks.push(text.slice(index, index + limit));
  }
  return chunks;
};

const runtimeStub = {
  channel: {
    text: {
      chunkMarkdownText,
      chunkMarkdownTextWithMode: chunkMarkdownText,
      resolveMarkdownTableMode: () => "code",
      convertMarkdownTables: (text: string) => text,
    },
  },
} as unknown as PluginRuntime;

const createNoopAdapter = (): MSTeamsAdapter => ({
  continueConversation: async () => {},
  process: async () => {},
});

const createRecordedSendActivity = (
  sink: string[],
  failFirstWithStatusCode?: number,
): ((activity: unknown) => Promise<{ id: string }>) => {
  let attempts = 0;
  return async (activity: unknown) => {
    const { text } = activity as { text?: string };
    const content = text ?? "";
    sink.push(content);
    attempts += 1;
    if (failFirstWithStatusCode !== undefined && attempts === 1) {
      throw Object.assign(new Error("send failed"), { statusCode: failFirstWithStatusCode });
    }
    return { id: `id:${content}` };
  };
};

describe("msteams messenger", () => {
  beforeEach(() => {
    setMSTeamsRuntime(runtimeStub);
    graphUploadMockState.uploadAndShareOneDrive.mockReset();
    graphUploadMockState.uploadAndShareOneDrive.mockResolvedValue({
      itemId: "item123",
      webUrl: "https://onedrive.example.com/item123",
      shareUrl: "https://onedrive.example.com/share/item123",
      name: "upload.txt",
    });
  });

  describe("renderReplyPayloadsToMessages", () => {
    it("filters silent replies", () => {
      const messages = renderReplyPayloadsToMessages([{ text: SILENT_REPLY_TOKEN }], {
        textChunkLimit: 4000,
        tableMode: "code",
      });
      expect(messages).toEqual([]);
    });

    it("does not filter non-exact silent reply prefixes", () => {
      const messages = renderReplyPayloadsToMessages(
        [{ text: `${SILENT_REPLY_TOKEN} -- ignored` }],
        { textChunkLimit: 4000, tableMode: "code" },
      );
      expect(messages).toEqual([{ text: `${SILENT_REPLY_TOKEN} -- ignored` }]);
    });

    it("splits media into separate messages by default", () => {
      const messages = renderReplyPayloadsToMessages(
        [{ text: "hi", mediaUrl: "https://example.com/a.png" }],
        { textChunkLimit: 4000, tableMode: "code" },
      );
      expect(messages).toEqual([{ text: "hi" }, { mediaUrl: "https://example.com/a.png" }]);
    });

    it("supports inline media mode", () => {
      const messages = renderReplyPayloadsToMessages(
        [{ text: "hi", mediaUrl: "https://example.com/a.png" }],
        { textChunkLimit: 4000, mediaMode: "inline", tableMode: "code" },
      );
      expect(messages).toEqual([{ text: "hi", mediaUrl: "https://example.com/a.png" }]);
    });

    it("chunks long text when enabled", () => {
      const long = "hello ".repeat(200);
      const messages = renderReplyPayloadsToMessages([{ text: long }], {
        textChunkLimit: 50,
        tableMode: "code",
      });
      expect(messages.length).toBeGreaterThan(1);
    });
  });

  describe("sendMSTeamsMessages", () => {
    const baseRef: StoredConversationReference = {
      activityId: "activity123",
      user: { id: "user123", name: "User" },
      agent: { id: "bot123", name: "Bot" },
      conversation: { id: "19:abc@thread.tacv2;messageid=deadbeef" },
      channelId: "msteams",
      serviceUrl: "https://service.example.com",
    };

    it("sends thread messages via the provided context", async () => {
      const sent: string[] = [];
      const ctx = {
        sendActivity: createRecordedSendActivity(sent),
      };
      const adapter = createNoopAdapter();

      const ids = await sendMSTeamsMessages({
        replyStyle: "thread",
        adapter,
        appId: "app123",
        conversationRef: baseRef,
        context: ctx,
        messages: [{ text: "one" }, { text: "two" }],
      });

      expect(sent).toEqual(["one", "two"]);
      expect(ids).toEqual(["id:one", "id:two"]);
    });

    it("sends top-level messages via continueConversation and strips activityId", async () => {
      const seen: { reference?: unknown; texts: string[] } = { texts: [] };

      const adapter: MSTeamsAdapter = {
        continueConversation: async (_appId, reference, logic) => {
          seen.reference = reference;
          await logic({
            sendActivity: createRecordedSendActivity(seen.texts),
          });
        },
        process: async () => {},
      };

      const ids = await sendMSTeamsMessages({
        replyStyle: "top-level",
        adapter,
        appId: "app123",
        conversationRef: baseRef,
        messages: [{ text: "hello" }],
      });

      expect(seen.texts).toEqual(["hello"]);
      expect(ids).toEqual(["id:hello"]);

      const ref = seen.reference as {
        activityId?: string;
        conversation?: { id?: string };
      };
      expect(ref.activityId).toBeUndefined();
      expect(ref.conversation?.id).toBe("19:abc@thread.tacv2");
    });

    it("preserves parsed mentions when appending OneDrive fallback file links", async () => {
      const tmpDir = await mkdtemp(path.join(resolvePreferredOpenClawTmpDir(), "msteams-mention-"));
      const localFile = path.join(tmpDir, "note.txt");
      await writeFile(localFile, "hello");

      try {
        const sent: Array<{ text?: string; entities?: unknown[] }> = [];
        const ctx = {
          sendActivity: async (activity: unknown) => {
            sent.push(activity as { text?: string; entities?: unknown[] });
            return { id: "id:one" };
          },
        };

        const adapter = createNoopAdapter();

        const ids = await sendMSTeamsMessages({
          replyStyle: "thread",
          adapter,
          appId: "app123",
          conversationRef: {
            ...baseRef,
            conversation: {
              ...baseRef.conversation,
              conversationType: "channel",
            },
          },
          context: ctx,
          messages: [{ text: "Hello @[John](29:08q2j2o3jc09au90eucae)", mediaUrl: localFile }],
          tokenProvider: {
            getAccessToken: async () => "token",
          },
        });

        expect(ids).toEqual(["id:one"]);
        expect(graphUploadMockState.uploadAndShareOneDrive).toHaveBeenCalledOnce();
        expect(sent).toHaveLength(1);
        expect(sent[0]?.text).toContain("Hello <at>John</at>");
        expect(sent[0]?.text).toContain(
          "📎 [upload.txt](https://onedrive.example.com/share/item123)",
        );
        expect(sent[0]?.entities).toEqual([
          {
            type: "mention",
            text: "<at>John</at>",
            mentioned: {
              id: "29:08q2j2o3jc09au90eucae",
              name: "John",
            },
          },
        ]);
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    });

    it("retries thread sends on throttling (429)", async () => {
      const attempts: string[] = [];
      const retryEvents: Array<{ nextAttempt: number; delayMs: number }> = [];

      const ctx = {
        sendActivity: createRecordedSendActivity(attempts, 429),
      };
      const adapter = createNoopAdapter();

      const ids = await sendMSTeamsMessages({
        replyStyle: "thread",
        adapter,
        appId: "app123",
        conversationRef: baseRef,
        context: ctx,
        messages: [{ text: "one" }],
        retry: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
        onRetry: (e) => retryEvents.push({ nextAttempt: e.nextAttempt, delayMs: e.delayMs }),
      });

      expect(attempts).toEqual(["one", "one"]);
      expect(ids).toEqual(["id:one"]);
      expect(retryEvents).toEqual([{ nextAttempt: 2, delayMs: 0 }]);
    });

    it("does not retry thread sends on client errors (4xx)", async () => {
      const ctx = {
        sendActivity: async () => {
          throw Object.assign(new Error("bad request"), { statusCode: 400 });
        },
      };

      const adapter = createNoopAdapter();

      await expect(
        sendMSTeamsMessages({
          replyStyle: "thread",
          adapter,
          appId: "app123",
          conversationRef: baseRef,
          context: ctx,
          messages: [{ text: "one" }],
          retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
        }),
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it("retries top-level sends on transient (5xx)", async () => {
      const attempts: string[] = [];

      const adapter: MSTeamsAdapter = {
        continueConversation: async (_appId, _reference, logic) => {
          await logic({ sendActivity: createRecordedSendActivity(attempts, 503) });
        },
        process: async () => {},
      };

      const ids = await sendMSTeamsMessages({
        replyStyle: "top-level",
        adapter,
        appId: "app123",
        conversationRef: baseRef,
        messages: [{ text: "hello" }],
        retry: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
      });

      expect(attempts).toEqual(["hello", "hello"]);
      expect(ids).toEqual(["id:hello"]);
    });
  });
});
