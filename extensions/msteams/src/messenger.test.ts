import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReplyPayload } from "../runtime-api.js";
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
import { createMockApp, createStoredReference } from "./messenger.test-helpers.js";
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

const baseRef = createStoredReference();
type SendParams = Parameters<typeof sendMSTeamsMessages>[0];
function send(params: Partial<SendParams> & Pick<SendParams, "messages">) {
  return sendMSTeamsMessages({
    replyStyle: "thread",
    app: createMockApp(),
    conversationRef: baseRef,
    ...params,
  });
}
function channelReference() {
  return { ...baseRef, conversation: { ...baseRef.conversation, conversationType: "channel" } };
}
async function withFile<T>(name: string, data: string | Buffer, run: (file: string) => Promise<T>) {
  const dir = await mkdtemp(path.join(resolvePreferredOpenClawTmpDir(), "msteams-media-"));
  try {
    const file = path.join(dir, name);
    await writeFile(file, data);
    return await run(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
async function captureSend(params: Partial<SendParams> & Pick<SendParams, "messages">) {
  const activities: Record<string, unknown>[] = [];
  let conversationId: string | undefined;
  const ids = await send({
    ...params,
    app: createMockApp({
      onReference: (activity) => activities.push(activity as Record<string, unknown>),
      onClientCreated: (_url, id) => {
        conversationId = id;
      },
    }),
  });
  return { ids, activities, conversationId };
}

describe("msteams messenger", () => {
  beforeEach(() => {
    setMSTeamsRuntime(runtimeStub);
    graphUploadMockState.uploadAndShareSharePoint.mockReset();
    graphUploadMockState.getDriveItemProperties.mockReset();
  });

  describe("renderReplyPayloadsToMessages", () => {
    it.each([
      { name: "card-only", text: undefined },
      {
        name: "text plus card",
        text: "Choose a deployment for @[Alex](11111111-2222-3333-4444-555555555555)",
      },
    ])("delivers $name through the Teams activity sender", async ({ text }) => {
      const presentation: NonNullable<ReplyPayload["presentation"]> = {
        title: "Deployment",
        blocks: [
          { type: "text", text: "Choose an environment" },
          { type: "buttons", buttons: [{ label: "Deploy", value: "deploy" }] },
        ],
      };
      let nextMessageId = 0;
      const sendActivity = vi.fn(async (_activity: unknown) => ({
        id: `reply-${++nextMessageId}`,
      }));
      const ids = await send({
        conversationRef: { conversation: { id: "conversation-1" } },
        context: { sendActivity },
        messages: renderReplyPayloadsToMessages([{ text, presentation }], {
          textChunkLimit: 4000,
          tableMode: "code",
        }),
      });

      expect(ids).toEqual(text ? ["reply-1", "reply-2"] : ["reply-1"]);
      if (text) {
        expect(sendActivity.mock.calls[0]?.[0]).toMatchObject({
          text: "Choose a deployment for <at>Alex</at>",
        });
      }
      const activity = sendActivity.mock.calls.at(-1)?.[0];
      expect(activity).not.toHaveProperty("text");
      expect(activity).toMatchObject({
        attachments: [
          {
            contentType: "application/vnd.microsoft.card.adaptive",
            content: { type: "AdaptiveCard" },
          },
        ],
        entities: expect.arrayContaining([
          expect.objectContaining({ additionalType: ["AIGeneratedContent"] }),
        ]),
      });
    });

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
      const { ids, activities, conversationId } = await captureSend({
        replyStyle: "top-level",
        messages: renderReplyPayloadsToMessages([{ text: source }], {
          textChunkLimit: 4000,
          tableMode: "off",
        }),
      });

      expect(activities.map((activity) => activity.text)).toEqual([expected]);
      expect(ids).toEqual([`id:${expected}`]);
      expect(conversationId).toBe("19:abc@thread.tacv2");
    });

    it("requires SharePoint storage for channel files", async () => {
      await withFile("note.txt", "hello", async (localFile) => {
        await expect(
          send({
            conversationRef: channelReference(),
            messages: [{ text: "one", mediaUrl: localFile }],
            tokenProvider: { getAccessToken: async () => "token" },
          }),
        ).rejects.toThrow("channels.msteams.sharePointSiteId is required");
      });
    });

    it.each([false, true])(
      "classifies preparation failure after sentFirst=%s",
      async (sentFirst) => {
        const sendActivity = vi.fn(async () => ({ id: "sent-first" }));
        const missingPath = path.join(resolvePreferredOpenClawTmpDir(), "missing-msteams-file.txt");
        const error = await send({
          context: { sendActivity },
          messages: [...(sentFirst ? [{ text: "first" }] : []), { mediaUrl: missingPath }],
        }).catch((cause: unknown) => cause);
        expect(sendActivity).toHaveBeenCalledTimes(sentFirst ? 1 : 0);
        expect(error).toBeInstanceOf(Error);
        if (sentFirst) {
          expect(error).not.toBeInstanceOf(PlatformMessageNotDispatchedError);
        } else {
          expect(error).toBeInstanceOf(PlatformMessageNotDispatchedError);
        }
      },
    );

    it("loads uppercase file URLs before sending personal images", async () => {
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
        "base64",
      );
      await withFile("café image.png", png, async (localFile) => {
        const mediaUrl = pathToFileURL(localFile).href.replace(/^file:/u, "FILE:");
        const { activities } = await captureSend({
          messages: [{ mediaUrl }],
          replyStyle: "top-level",
          conversationRef: {
            ...baseRef,
            conversation: { ...baseRef.conversation, conversationType: "personal" },
          },
        });
        expect(activities).toMatchObject([
          {
            attachments: [
              {
                name: "café image.png",
                contentType: "image/png",
                contentUrl: `data:image/png;base64,${png.toString("base64")}`,
              },
            ],
          },
        ]);
      });
    });

    it("marks invalid proactive conversation references as never dispatched", async () => {
      await expect(
        send({
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
      await withFile("retry.txt", "hello", async (localFile) => {
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
        const ids = await send({
          conversationRef: channelReference(),
          context: ctx,
          messages: [{ text: "one", mediaUrl: localFile }],
          tokenProvider: { getAccessToken: async () => "token" },
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
    });

    it("does not retry thread sends on client errors (4xx)", async () => {
      const ctx = {
        sendActivity: async () => {
          throw Object.assign(new Error("bad request"), { statusCode: 400 });
        },
      };

      await expect(
        send({
          context: ctx,
          messages: [{ text: "one" }],
        }),
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it.each([
      ["legacy activity root", "thread", undefined, "activity456"],
      ["canonical thread root (#58030)", "thread", "thread-root", "thread-root"],
      ["top-level despite stored root", "top-level", "thread-root", undefined],
    ] as const)("routes %s without a live context", async (_name, replyStyle, threadId, root) => {
      const { activities, conversationId } = await captureSend({
        messages: [{ text: "hello" }],
        replyStyle,
        conversationRef: createStoredReference({
          conversation: {
            id: "19:abc@thread.tacv2;messageid=deadbeef",
            conversationType: "channel",
          },
          activityId: threadId ? "current-message-id" : "activity456",
          threadId,
        }),
      });
      expect(activities.map((activity) => activity.text)).toEqual(["hello"]);
      expect(conversationId).toBe(`19:abc@thread.tacv2${root ? `;messageid=${root}` : ""}`);
    });

    it.each(["ETIMEDOUT"])(
      "does not retry top-level sends after ambiguous transport %s",
      async (code) => {
        const attempts: string[] = [];
        const error = await send({
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
      const error = await send({
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
    const personalRef = createStoredReference({
      conversation: { id: "conv123", conversationType: "personal" },
    });

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

          await send({
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

  describe("buildConversationReference tenant/aad forwarding (#58774)", () => {
    const storedWithChannelDataTenant = createStoredReference({
      tenantId: "tenant-abc",
      aadObjectId: "aad-user-123",
    });

    it("accepts a legacy bot-only imported reference and resolves the agent from bot", () => {
      const botOnly = {
        user: { id: "user-legacy" },
        bot: { id: "bot-legacy", name: "Bot" },
        conversation: { id: "a:personal-chat" },
      };
      const reference = buildConversationReference(botOnly);
      expect(reference.agent).toEqual({ id: "bot-legacy", name: "Bot" });
    });

    it("propagates tenantId/aadObjectId through sendMSTeamsMessages proactive path", async () => {
      const { ids, activities } = await captureSend({
        replyStyle: "top-level",
        conversationRef: storedWithChannelDataTenant,
        messages: [{ text: "hello" }],
      });

      expect(activities.map((activity) => activity.text)).toEqual(["hello"]);
      expect(ids).toEqual(["id:hello"]);
      expect(activities).toEqual([
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
    });
  });
});
