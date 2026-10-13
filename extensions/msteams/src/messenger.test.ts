// Msteams tests cover messenger plugin behavior.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

const REVOCATION_ERROR = "Cannot perform 'set' on a proxy that has been revoked";

async function buildActivity(
  message: Parameters<typeof sendMSTeamsMessages>[0]["messages"][number],
  conversationRef: StoredConversationReference,
  tokenProvider?: Parameters<typeof sendMSTeamsMessages>[0]["tokenProvider"],
  sharePointSiteId?: string,
  mediaMaxBytes?: number,
  options?: { feedbackLoopEnabled?: boolean },
): Promise<Record<string, unknown>> {
  let captured: Record<string, unknown> | undefined;
  const app = createMockApp({
    createFn: async (activity) => {
      captured = activity as Record<string, unknown>;
      return { id: "captured" };
    },
  });
  await sendMSTeamsMessages({
    replyStyle: "top-level",
    app,
    conversationRef,
    messages: [message],
    tokenProvider,
    sharePointSiteId,
    mediaMaxBytes,
    feedbackLoopEnabled: options?.feedbackLoopEnabled,
  });
  if (!captured) {
    throw new Error("expected Teams activity to be sent");
  }
  return captured;
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
    function createRevokedThreadContext(params?: { failAfterAttempt?: number; sent?: string[] }) {
      let attempt = 0;
      return {
        sendActivity: async (activity: unknown) => {
          const { text } = activity as { text?: string };
          const content = text ?? "";
          attempt += 1;
          if (params?.failAfterAttempt && attempt < params.failAfterAttempt) {
            params.sent?.push(content);
            return { id: `id:${content}` };
          }
          throw new TypeError(REVOCATION_ERROR);
        },
      };
    }

    const baseRef: StoredConversationReference = {
      activityId: "activity123",
      user: { id: "user123", name: "User" },
      agent: { id: "bot123", name: "Bot" },
      conversation: { id: "19:abc@thread.tacv2;messageid=deadbeef" },
      channelId: "msteams",
      serviceUrl: "https://smba.trafficmanager.net/amer/",
    };

    async function sendAndCaptureRevokeFallbackReference(params: {
      conversation: StoredConversationReference["conversation"];
      activityId?: string;
      threadId?: string;
    }) {
      const proactiveSent: string[] = [];
      let capturedConversationId: string | undefined;
      const conversationRef: StoredConversationReference = {
        activityId: params.activityId ?? "activity456",
        user: { id: "user123", name: "User" },
        agent: { id: "bot123", name: "Bot" },
        conversation: params.conversation,
        channelId: "msteams",
        serviceUrl: "https://smba.trafficmanager.net/amer/",
        ...(params.threadId ? { threadId: params.threadId } : {}),
      };

      await sendMSTeamsMessages({
        replyStyle: "thread",
        app: createMockApp({
          createFn: createRecordedSendActivity(proactiveSent),
          onClientCreated: (_serviceUrl, conversationId) => {
            capturedConversationId = conversationId;
          },
        }),
        conversationRef,
        context: createRevokedThreadContext(),
        messages: [{ text: "hello" }],
      });

      return {
        proactiveSent,
        // Reconstruct a reference-like shape from captured conversationId for assertion compat
        reference: {
          conversation: capturedConversationId ? { id: capturedConversationId } : undefined,
          activityId: undefined,
        },
      };
    }

    it.each(
      teamsMarkdownDeliveryCases.filter(
        ({ name }) => name === "plain text" || name === "raw table after list-fence outdent",
      ),
    )("sends $name via proactive send context", async ({ source, expected }) => {
      const texts: string[] = [];
      let capturedConversationId: string | undefined;

      const ids = await sendMSTeamsMessages({
        replyStyle: "top-level",
        app: createMockApp({
          createFn: createRecordedSendActivity(texts),
          onClientCreated: (_serviceUrl, conversationId) => {
            capturedConversationId = conversationId;
          },
        }),
        conversationRef: baseRef,
        messages: renderReplyPayloadsToMessages([{ text: source }], {
          textChunkLimit: 4000,
          tableMode: "off",
        }),
      });

      expect(texts).toEqual([expected]);
      expect(ids).toEqual([`id:${expected}`]);
      expect(capturedConversationId).toBe("19:abc@thread.tacv2");
    });

    it("requires SharePoint storage for channel files", async () => {
      const tmpDir = await mkdtemp(path.join(resolvePreferredOpenClawTmpDir(), "msteams-storage-"));
      const localFile = path.join(tmpDir, "note.txt");
      await writeFile(localFile, "hello");

      try {
        await expect(
          sendMSTeamsMessages({
            replyStyle: "thread",
            app: createMockApp(),
            conversationRef: {
              ...baseRef,
              conversation: {
                ...baseRef.conversation,
                conversationType: "channel",
              },
            },
            messages: [{ text: "one", mediaUrl: localFile }],
            tokenProvider: { getAccessToken: async () => "token" },
          }),
        ).rejects.toThrow("channels.msteams.sharePointSiteId is required");
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    });

    it("marks local activity preparation failures as never dispatched", async () => {
      const sendActivity = vi.fn(async () => ({ id: "should-not-send" }));
      const missingPath = path.join(resolvePreferredOpenClawTmpDir(), "missing-msteams-file.txt");

      await expect(
        sendMSTeamsMessages({
          replyStyle: "thread",
          app: createMockApp(),
          conversationRef: baseRef,
          context: { sendActivity },
          messages: [{ mediaUrl: missingPath }],
        }),
      ).rejects.toBeInstanceOf(PlatformMessageNotDispatchedError);
      expect(sendActivity).not.toHaveBeenCalled();
    });

    it("loads uppercase file URLs before sending personal images", async () => {
      const tmpDir = await mkdtemp(
        path.join(resolvePreferredOpenClawTmpDir(), "msteams-file-url-"),
      );
      const localFile = path.join(tmpDir, "café image.png");
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
        "base64",
      );
      await writeFile(localFile, png);

      try {
        const mediaUrl = pathToFileURL(localFile).href.replace(/^file:/u, "FILE:");
        const activity = await buildActivity(
          { mediaUrl },
          {
            ...baseRef,
            conversation: { ...baseRef.conversation, conversationType: "personal" },
          },
        );
        const attachment = (activity.attachments as Array<Record<string, unknown>>)[0];

        expect(attachment).toMatchObject({
          name: "café image.png",
          contentType: "image/png",
          contentUrl: `data:image/png;base64,${png.toString("base64")}`,
        });
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    });

    it("does not claim no dispatch after an earlier batch message was sent", async () => {
      const sendActivity = vi.fn(async () => ({ id: "sent-first" }));
      const missingPath = path.join(resolvePreferredOpenClawTmpDir(), "missing-second-file.txt");

      const error = await sendMSTeamsMessages({
        replyStyle: "thread",
        app: createMockApp(),
        conversationRef: baseRef,
        context: { sendActivity },
        messages: [{ text: "first" }, { mediaUrl: missingPath }],
      }).catch((cause: unknown) => cause);

      expect(sendActivity).toHaveBeenCalledTimes(1);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(PlatformMessageNotDispatchedError);
    });

    it("does not claim no dispatch when proactive fallback preparation fails after a send", async () => {
      const threadSent: string[] = [];
      const error = await sendMSTeamsMessages({
        replyStyle: "thread",
        app: createMockApp(),
        conversationRef: {
          ...baseRef,
          user: undefined,
        },
        context: createRevokedThreadContext({ failAfterAttempt: 2, sent: threadSent }),
        messages: [{ text: "first" }, { text: "second" }],
      }).catch((cause: unknown) => cause);

      expect(threadSent).toEqual(["first"]);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(PlatformMessageNotDispatchedError);
      expect((error as Error).message).toContain("missing user.id");
    });

    it("marks invalid proactive conversation references as never dispatched", async () => {
      await expect(
        sendMSTeamsMessages({
          replyStyle: "top-level",
          app: createMockApp(),
          conversationRef: {
            ...baseRef,
            conversation: { id: "" },
          },
          messages: [{ text: "hello" }],
        }),
      ).rejects.toBeInstanceOf(PlatformMessageNotDispatchedError);
    });

    it("retries media preparation but reuses it after provider dispatch starts", async () => {
      const tmpDir = await mkdtemp(path.join(resolvePreferredOpenClawTmpDir(), "msteams-retry-"));
      const localFile = path.join(tmpDir, "retry.txt");
      await writeFile(localFile, "hello");

      try {
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
        const ids = await sendMSTeamsMessages({
          replyStyle: "thread",
          app: createMockApp(),
          conversationRef: {
            ...baseRef,
            conversation: {
              ...baseRef.conversation,
              conversationType: "channel",
            },
          },
          context: ctx,
          messages: [{ text: "one", mediaUrl: localFile }],
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
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    });

    it("does not retry thread sends on client errors (4xx)", async () => {
      const ctx = {
        sendActivity: async () => {
          throw Object.assign(new Error("bad request"), { statusCode: 400 });
        },
      };

      await expect(
        sendMSTeamsMessages({
          replyStyle: "thread",
          app: createMockApp(),
          conversationRef: baseRef,
          context: ctx,
          messages: [{ text: "one" }],
        }),
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it("falls back only for remaining thread messages after context revocation", async () => {
      const threadSent: string[] = [];
      const proactiveSent: string[] = [];
      const ctx = createRevokedThreadContext({ failAfterAttempt: 2, sent: threadSent });

      const ids = await sendMSTeamsMessages({
        replyStyle: "thread",
        app: createMockApp({ createFn: createRecordedSendActivity(proactiveSent) }),
        conversationRef: baseRef,
        context: ctx,
        messages: [{ text: "one" }, { text: "two" }, { text: "three" }],
      });

      expect(threadSent).toEqual(["one"]);
      expect(proactiveSent).toEqual(["two", "three"]);
      expect(ids).toEqual(["id:one", "id:two", "id:three"]);
    });

    it("reconstructs threaded conversation ID for channel revoke fallback", async () => {
      const { proactiveSent, reference } = await sendAndCaptureRevokeFallbackReference({
        conversation: {
          id: "19:abc@thread.tacv2;messageid=deadbeef",
          conversationType: "channel",
        },
      });

      expect(proactiveSent).toEqual(["hello"]);
      // Conversation ID should include the thread suffix for channel messages
      expect(reference.conversation?.id).toBe("19:abc@thread.tacv2;messageid=activity456");
      expect(reference.activityId).toBeUndefined();
    });

    it("uses threadId instead of activityId for channel revoke fallback (#58030)", async () => {
      const { proactiveSent, reference } = await sendAndCaptureRevokeFallbackReference({
        activityId: "current-message-id",
        conversation: {
          id: "19:abc@thread.tacv2",
          conversationType: "channel",
        },
        // threadId is the thread root, which differs from activityId (current message)
        threadId: "thread-root-msg-id",
      });

      expect(proactiveSent).toEqual(["hello"]);
      // Should use threadId (thread root), NOT activityId (current message)
      expect(reference.conversation?.id).toBe("19:abc@thread.tacv2;messageid=thread-root-msg-id");
      expect(reference.activityId).toBeUndefined();
    });

    it("does not add thread suffix for top-level replyStyle even with threadId set", async () => {
      const sent: string[] = [];
      let capturedConversationId: string | undefined;

      const channelRef: StoredConversationReference = {
        activityId: "current-msg",
        user: { id: "user123", name: "User" },
        agent: { id: "bot123", name: "Bot" },
        conversation: {
          id: "19:abc@thread.tacv2",
          conversationType: "channel",
        },
        channelId: "msteams",
        serviceUrl: "https://smba.trafficmanager.net/amer/",
        threadId: "thread-root-msg-id",
      };

      await sendMSTeamsMessages({
        replyStyle: "top-level",
        app: createMockApp({
          createFn: createRecordedSendActivity(sent),
          onClientCreated: (_serviceUrl, conversationId) => {
            capturedConversationId = conversationId;
          },
        }),
        conversationRef: channelRef,
        messages: [{ text: "hello" }],
      });

      expect(sent).toEqual(["hello"]);
      // Top-level sends should NOT include thread suffix
      expect(capturedConversationId).toBe("19:abc@thread.tacv2");
    });

    it.each(["ETIMEDOUT"])(
      "does not retry top-level sends after ambiguous transport %s",
      async (code) => {
        const attempts: string[] = [];
        const error = await sendMSTeamsMessages({
          replyStyle: "top-level",
          app: createMockApp({
            createFn: async (activity) => {
              attempts.push((activity as { text?: string }).text ?? "");
              throw Object.assign(new Error(code), { code });
            },
          }),
          conversationRef: baseRef,
          messages: [{ text: "hello" }],
        }).catch((cause: unknown) => cause);

        expect(attempts).toEqual(["hello"]);
        expect(error).toMatchObject({ code });
      },
    );

    it("does not replay accepted blocks when a later block has an ambiguous failure", async () => {
      const attempts: string[] = [];
      const error = await sendMSTeamsMessages({
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
        conversationRef: baseRef,
        messages: [{ text: "first" }, { text: "second" }],
      }).catch((cause: unknown) => cause);

      expect(attempts).toEqual(["first", "second"]);
      expect(error).toMatchObject({ statusCode: 504 });
      expect(error).not.toBeInstanceOf(PlatformMessageNotDispatchedError);
    });
  });

  describe("buildActivity AI metadata", () => {
    const baseRef: StoredConversationReference = {
      activityId: "activity123",
      user: { id: "user123", name: "User" },
      agent: { id: "bot123", name: "Bot" },
      conversation: { id: "conv123", conversationType: "personal" },
      channelId: "msteams",
      serviceUrl: "https://smba.trafficmanager.net/amer/",
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

          await sendMSTeamsMessages({
            replyStyle: "top-level",
            app,
            conversationRef: baseRef,
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
      activityId: "activity-1",
      user: { id: "user123", name: "User", aadObjectId: "aad-user-123" },
      agent: { id: "bot123", name: "Bot" },
      conversation: {
        id: "19:abc@thread.tacv2",
        conversationType: "channel",
      },
      // Canonical channelData source captured by message-handler inbound code.
      tenantId: "tenant-abc",
      aadObjectId: "aad-user-123",
      channelId: "msteams",
      serviceUrl: "https://smba.trafficmanager.net/amer/",
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
      const sent: string[] = [];
      const refs: unknown[] = [];

      const ids = await sendMSTeamsMessages({
        replyStyle: "top-level",
        app: createMockApp({
          createFn: createRecordedSendActivity(sent),
          onReference: (ref) => refs.push(ref),
        }),
        conversationRef: storedWithChannelDataTenant,
        messages: [{ text: "hello" }],
      });

      expect(sent).toEqual(["hello"]);
      expect(ids).toEqual(["id:hello"]);
      expect(refs).toEqual([
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
