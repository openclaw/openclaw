import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredConversationReference } from "./conversation-store.js";
import { teamsMarkdownDeliveryCases } from "./format.test-fixtures.js";
const graphUploadMockState = vi.hoisted(() => ({
  uploadAndShareSharePoint: vi.fn(),
  getDriveItemProperties: vi.fn(),
}));

vi.mock("./graph-upload.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./graph-upload.js")>();
  return {
    ...actual,
    uploadAndShareSharePoint: graphUploadMockState.uploadAndShareSharePoint,
    getDriveItemProperties: graphUploadMockState.getDriveItemProperties,
  };
});

import {
  buildConversationReference,
  renderReplyPayloadsToMessages,
  sendMSTeamsMessages,
} from "./messenger.js";
import { createMockApp } from "./messenger.test-helpers.js";
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
  config: {
    loadConfig: () => ({}),
  },
  channel: {
    text: {
      chunkMarkdownText,
      chunkMarkdownTextWithMode: chunkMarkdownText,
      resolveMarkdownTableMode: () => "code",
      convertMarkdownTables: (text: string) => text,
    },
  },
} as unknown as PluginRuntime;

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
      throw Object.assign(new Error("send failed"), {
        statusCode: failFirstWithStatusCode,
        ...(failFirstWithStatusCode === 429 ? { retryAfterMs: 0 } : {}),
      });
    }
    return { id: `id:${content}` };
  };
};

const baseRef: StoredConversationReference = {
  activityId: "activity123",
  user: { id: "user123", name: "User" },
  agent: { id: "bot123", name: "Bot" },
  conversation: { id: "19:abc@thread.tacv2;messageid=deadbeef" },
  channelId: "msteams",
  serviceUrl: "https://smba.trafficmanager.net/amer/",
};

type SendParams = Parameters<typeof sendMSTeamsMessages>[0];
function sendMessages(params: Pick<SendParams, "messages"> & Partial<SendParams>) {
  return sendMSTeamsMessages({
    replyStyle: "thread",
    app: createMockApp(),
    conversationRef: baseRef,
    ...params,
  });
}

let temporaryDirectories: string[] = [];
async function localFile(name: string, content: string | Buffer) {
  const directory = await mkdtemp(path.join(resolvePreferredOpenClawTmpDir(), "msteams-"));
  temporaryDirectories.push(directory);
  const filename = path.join(directory, name);
  await writeFile(filename, content);
  return filename;
}
afterEach(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
  temporaryDirectories = [];
});

function recordSend() {
  const texts: string[] = [];
  const activities: Array<Record<string, unknown>> = [];
  const conversationIds: string[] = [];
  const references: unknown[] = [];
  const send = createRecordedSendActivity(texts);
  const app = createMockApp({
    createFn: async (activity) => {
      activities.push(activity as Record<string, unknown>);
      return send(activity);
    },
    onClientCreated: (_serviceUrl, id) => conversationIds.push(id),
    onReference: (reference) => references.push(reference),
  });
  return { app, texts, activities, conversationIds, references };
}

describe("msteams messenger", () => {
  beforeEach(() => {
    setMSTeamsRuntime(runtimeStub);
    graphUploadMockState.uploadAndShareSharePoint.mockReset();
    graphUploadMockState.getDriveItemProperties.mockReset();
  });

  describe("renderReplyPayloadsToMessages", () => {
    it("splits media into separate messages by default", () => {
      const messages = renderReplyPayloadsToMessages(
        [{ text: "hi", mediaUrl: "https://example.com/a.png" }],
        { textChunkLimit: 4000, tableMode: "code" },
      );
      expect(messages).toEqual([{ text: "hi" }, { mediaUrl: "https://example.com/a.png" }]);
    });
  });

  describe("sendMSTeamsMessages", () => {
    it.each(
      teamsMarkdownDeliveryCases.filter(
        ({ name }) => name === "plain text" || name === "raw table after list-fence outdent",
      ),
    )("sends $name via proactive send context", async ({ source, expected }) => {
      const { app, texts, conversationIds } = recordSend();
      const ids = await sendMessages({
        replyStyle: "top-level",
        app,
        messages: renderReplyPayloadsToMessages([{ text: source }], {
          textChunkLimit: 4000,
          tableMode: "off",
        }),
      });

      expect(texts).toEqual([expected]);
      expect(ids).toEqual([`id:${expected}`]);
      expect(conversationIds).toEqual(["19:abc@thread.tacv2"]);
    });

    it("requires SharePoint storage for channel files", async () => {
      const filename = await localFile("note.txt", "hello");
      await expect(
        sendMessages({
          conversationRef: {
            ...baseRef,
            conversation: {
              ...baseRef.conversation,
              conversationType: "channel",
            },
          },
          messages: [{ text: "one", mediaUrl: filename }],
          tokenProvider: { getAccessToken: async () => "token" },
        }),
      ).rejects.toThrow("channels.msteams.sharePointSiteId is required");
    });

    it("marks local activity preparation failures as never dispatched", async () => {
      const sendActivity = vi.fn(async () => ({ id: "should-not-send" }));
      const missingPath = path.join(resolvePreferredOpenClawTmpDir(), "missing-msteams-file.txt");

      await expect(
        sendMessages({
          context: { sendActivity },
          messages: [{ mediaUrl: missingPath }],
        }),
      ).rejects.toBeInstanceOf(PlatformMessageNotDispatchedError);
      expect(sendActivity).not.toHaveBeenCalled();
    });

    it("loads uppercase file URLs before sending personal images", async () => {
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
        "base64",
      );
      const filename = await localFile("café image.png", png);
      const mediaUrl = pathToFileURL(filename).href.replace(/^file:/u, "FILE:");
      const { app, activities } = recordSend();
      await sendMessages({
        replyStyle: "top-level",
        app,
        messages: [{ mediaUrl }],
        conversationRef: {
          ...baseRef,
          conversation: { ...baseRef.conversation, conversationType: "personal" },
        },
      });
      const attachment = (activities[0].attachments as Array<Record<string, unknown>>)[0];

      expect(attachment).toMatchObject({
        name: "café image.png",
        contentType: "image/png",
        contentUrl: `data:image/png;base64,${png.toString("base64")}`,
      });
    });

    it("does not claim no dispatch after an earlier batch message was sent", async () => {
      const sendActivity = vi.fn(async () => ({ id: "sent-first" }));
      const missingPath = path.join(resolvePreferredOpenClawTmpDir(), "missing-second-file.txt");

      const error = await sendMessages({
        context: { sendActivity },
        messages: [{ text: "first" }, { mediaUrl: missingPath }],
      }).catch((cause: unknown) => cause);

      expect(sendActivity).toHaveBeenCalledTimes(1);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(PlatformMessageNotDispatchedError);
    });

    it("marks invalid proactive conversation references as never dispatched", async () => {
      await expect(
        sendMessages({
          replyStyle: "top-level",
          conversationRef: {
            ...baseRef,
            conversation: { id: "" },
          },
          messages: [{ text: "hello" }],
        }),
      ).rejects.toBeInstanceOf(PlatformMessageNotDispatchedError);
    });

    it("retries media preparation but reuses it after provider dispatch starts", async () => {
      const filename = await localFile("retry.txt", "hello");
      const attempts: string[] = [];
      const providerPayloads: string[] = [];
      const retryEvents: Array<{ nextAttempt: number; delayMs: number }> = [];
      let uploadAttempts = 0;
      graphUploadMockState.uploadAndShareSharePoint.mockImplementation(async () => {
        uploadAttempts += 1;
        if (uploadAttempts === 1) {
          throw Object.assign(new Error("transient upload failure"), {
            statusCode: 429,
            retryAfterMs: 0,
          });
        }
        return {
          itemId: "item123",
          webUrl: "https://sharepoint.example.com/item123",
          shareUrl: "https://sharepoint.example.com/share/item123",
          name: "retry.txt",
        };
      });
      graphUploadMockState.getDriveItemProperties.mockResolvedValue({
        eTag: '"{ITEM-123},1"',
        webDavUrl: "https://sharepoint.example.com/item123",
        name: "retry.txt",
      });

      const sendActivity = createRecordedSendActivity(attempts, 429);
      const ctx = {
        sendActivity: async (activity: unknown) => {
          providerPayloads.push(JSON.stringify(activity));
          return await sendActivity(activity);
        },
      };
      const ids = await sendMessages({
        conversationRef: {
          ...baseRef,
          conversation: {
            ...baseRef.conversation,
            conversationType: "channel",
          },
        },
        context: ctx,
        messages: [{ text: "one", mediaUrl: filename }],
        tokenProvider: {
          getAccessToken: async () => "token",
        },
        sharePointSiteId: "site-123",
        onRetry: (e) => retryEvents.push({ nextAttempt: e.nextAttempt, delayMs: e.delayMs }),
      });

      expect(uploadAttempts).toBe(2);
      expect(attempts).toEqual(["one", "one"]);
      expect(providerPayloads[1]).toBe(providerPayloads[0]);
      expect(ids).toEqual(["id:one"]);
      expect(retryEvents).toEqual([
        { nextAttempt: 2, delayMs: 0 },
        { nextAttempt: 3, delayMs: 0 },
      ]);
    });

    it("does not retry thread sends on client errors (4xx)", async () => {
      const ctx = {
        sendActivity: async () => {
          throw Object.assign(new Error("bad request"), { statusCode: 400 });
        },
      };

      await expect(
        sendMessages({
          context: ctx,
          messages: [{ text: "one" }],
        }),
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it.each([
      {
        replyStyle: "thread",
        activityId: "activity456",
        id: "19:abc@thread.tacv2;messageid=deadbeef",
        threadId: undefined,
        expected: "19:abc@thread.tacv2;messageid=activity456",
      },
      {
        replyStyle: "thread",
        activityId: "current-message-id",
        id: "19:abc@thread.tacv2",
        threadId: "thread-root-msg-id",
        expected: "19:abc@thread.tacv2;messageid=thread-root-msg-id",
      },
      {
        replyStyle: "top-level",
        activityId: "current-msg",
        id: "19:abc@thread.tacv2",
        threadId: "thread-root-msg-id",
        expected: "19:abc@thread.tacv2",
      },
    ] as const)(
      "routes $replyStyle with threadId=$threadId (#58030)",
      async ({ replyStyle, activityId, id, threadId, expected }) => {
        const { app, texts, conversationIds } = recordSend();
        await sendMessages({
          app,
          replyStyle,
          messages: [{ text: "hello" }],
          conversationRef: {
            ...baseRef,
            activityId,
            threadId,
            conversation: { id, conversationType: "channel" },
          },
        });
        expect(texts).toEqual(["hello"]);
        expect(conversationIds).toEqual([expected]);
      },
    );

    it.each(["ETIMEDOUT"])(
      "does not retry top-level sends after ambiguous transport %s",
      async (code) => {
        const attempts: string[] = [];
        const error = await sendMessages({
          replyStyle: "top-level",
          app: createMockApp({
            createFn: async (activity) => {
              attempts.push((activity as { text?: string }).text ?? "");
              throw Object.assign(new Error(code), { code });
            },
          }),
          messages: [{ text: "hello" }],
        }).catch((cause: unknown) => cause);

        expect(attempts).toEqual(["hello"]);
        expect(error).toMatchObject({ code });
      },
    );

    it("does not replay accepted blocks when a later block has an ambiguous failure", async () => {
      const attempts: string[] = [];
      const error = await sendMessages({
        replyStyle: "top-level",
        app: createMockApp({
          createFn: async (activity) => {
            const text = (activity as { text?: string }).text ?? "";
            attempts.push(text);
            if (text === "second") {
              throw Object.assign(new Error("gateway timeout"), { statusCode: 504 });
            }
            return { id: `id:${text}` };
          },
        }),
        messages: [{ text: "first" }, { text: "second" }],
      }).catch((cause: unknown) => cause);

      expect(attempts).toEqual(["first", "second"]);
      expect(error).toMatchObject({ statusCode: 504 });
      expect(error).not.toBeInstanceOf(PlatformMessageNotDispatchedError);
    });
  });

  describe("buildActivity AI metadata", () => {
    const personalRef: StoredConversationReference = {
      ...baseRef,
      conversation: { id: "conv123", conversationType: "personal" },
    };

    it("sends decoded attachment filenames over the Bot Framework HTTP transport", async () => {
      const receivedAttachments: Array<{ name: string; contentUrl: string }> = [];

      await withServer(
        (request, response) => {
          const chunks: Buffer[] = [];
          request.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
          request.on("end", () => {
            const activity = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
              attachments?: Array<{ name: string; contentUrl: string }>;
            };
            receivedAttachments.push(
              ...(activity.attachments ?? []).map(({ name, contentUrl }) => ({ name, contentUrl })),
            );
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({ id: `message-${receivedAttachments.length}` }));
          });
        },
        async (baseUrl) => {
          const app = createMockApp({
            createFn: async (activity) => {
              const response = await fetch(`${baseUrl}/v3/conversations/test/activities`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(activity),
              });
              return await response.json();
            },
          });
          const encodedNames = ["My%20report.pdf", "r%C3%A9sum%C3%A9.pdf", "100%25.png"];

          await sendMessages({
            replyStyle: "top-level",
            app,
            conversationRef: personalRef,
            messages: encodedNames.map((name) => ({
              mediaUrl: `${baseUrl}/files/${name}`,
            })),
          });

          expect(receivedAttachments).toEqual([
            { name: "My report.pdf", contentUrl: `${baseUrl}/files/My%20report.pdf` },
            { name: "résumé.pdf", contentUrl: `${baseUrl}/files/r%C3%A9sum%C3%A9.pdf` },
            { name: "100%.png", contentUrl: `${baseUrl}/files/100%25.png` },
          ]);
        },
      );
    });
  });

  // Regression coverage for #58774: proactive Teams sends fail with HTTP 403
  // when the Bot Framework connector does not see `tenantId` / `aadObjectId`
  // on the outbound conversation reference.
  describe("buildConversationReference tenant/aad forwarding (#58774)", () => {
    const storedWithChannelDataTenant: StoredConversationReference = {
      ...baseRef,
      activityId: "activity-1",
      user: { id: "user123", name: "User", aadObjectId: "aad-user-123" },
      conversation: {
        id: "19:abc@thread.tacv2",
        conversationType: "channel",
      },
      tenantId: "tenant-abc",
      aadObjectId: "aad-user-123",
    };

    it("accepts a legacy bot-only imported reference and resolves the agent from bot", () => {
      const botOnly: StoredConversationReference = {
        activityId: "activity-bot-only",
        user: { id: "user-legacy", name: "Legacy" },
        bot: { id: "bot-legacy", name: "Bot" },
        conversation: {
          id: "a:personal-chat",
          conversationType: "personal",
          tenantId: "tenant-1",
        },
        channelId: "msteams",
        serviceUrl: "https://smba.trafficmanager.net/amer/",
      };
      const reference = buildConversationReference(botOnly);
      expect(reference.agent).toEqual({ id: "bot-legacy", name: "Bot" });
    });

    it("propagates tenantId/aadObjectId through sendMSTeamsMessages proactive path", async () => {
      const { app, texts, references } = recordSend();
      const ids = await sendMessages({
        replyStyle: "top-level",
        app,
        conversationRef: storedWithChannelDataTenant,
        messages: [{ text: "hello" }],
      });

      expect(texts).toEqual(["hello"]);
      expect(ids).toEqual(["id:hello"]);
      expect(references).toEqual([
        expect.objectContaining({
          serviceUrl: "https://smba.trafficmanager.net/amer",
          tenantId: "tenant-abc",
          aadObjectId: "aad-user-123",
          conversation: expect.objectContaining({
            id: "19:abc@thread.tacv2",
            tenantId: "tenant-abc",
          }),
          recipient: expect.objectContaining({ aadObjectId: "aad-user-123" }),
        }),
      ]);
      const ref = buildConversationReference(storedWithChannelDataTenant);
      expect(ref.tenantId).toBe("tenant-abc");
      expect(ref.aadObjectId).toBe("aad-user-123");
    });
  });
});
