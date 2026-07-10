// Googlechat attachment tests cover inbound batch materialization and agent context.
import { buildChannelInboundEventContext } from "openclaw/plugin-sdk/channel-inbound";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedGoogleChatAccount } from "./accounts.js";
import type { GoogleChatCoreRuntime, GoogleChatRuntimeEnv } from "./monitor-types.js";
import { testing } from "./monitor.js";
import type { GoogleChatAttachment, GoogleChatEvent } from "./types.js";

const apiMocks = vi.hoisted(() => ({
  downloadGoogleChatMedia: vi.fn(),
  sendGoogleChatMessage: vi.fn(),
}));

const accessMocks = vi.hoisted(() => ({
  applyGoogleChatInboundAccessPolicy: vi.fn(),
}));

vi.mock("./api.js", () => ({
  downloadGoogleChatMedia: apiMocks.downloadGoogleChatMedia,
  sendGoogleChatMessage: apiMocks.sendGoogleChatMessage,
}));

vi.mock("./monitor-access.js", () => ({
  applyGoogleChatInboundAccessPolicy: accessMocks.applyGoogleChatInboundAccessPolicy,
}));

const account = {
  accountId: "work",
  config: { typingIndicator: "none" },
  credentialSource: "inline",
} as ResolvedGoogleChatAccount;

type BuiltContext = {
  Body: string;
  BodyForAgent: string;
  RawBody: string;
  CommandBody: string;
  MediaPaths?: string[];
  MediaUrls?: string[];
  MediaTypes?: string[];
};

type IngestedMessage = {
  rawText: string;
  textForAgent: string;
  textForCommands: string;
};

function uploadedAttachment(id: string, contentType = "image/png"): GoogleChatAttachment {
  return {
    contentName: `${id}.${contentType === "application/pdf" ? "pdf" : "png"}`,
    contentType,
    attachmentDataRef: { resourceName: `media/${id}` },
  };
}

function attachmentEvent(params: {
  attachments: GoogleChatAttachment[];
  text?: string;
}): GoogleChatEvent {
  return {
    type: "MESSAGE",
    space: { name: "spaces/DM", type: "DM" },
    message: {
      name: "spaces/DM/messages/attachments",
      text: params.text,
      sender: { name: "users/alice", displayName: "Alice", type: "HUMAN" },
      attachment: params.attachments,
    },
  };
}

function createHarness() {
  const buildContext = vi.fn(buildChannelInboundEventContext);
  const runTurn = vi.fn();
  const saveMediaBuffer = vi.fn();
  const runtime = { error: vi.fn(), log: vi.fn() } satisfies GoogleChatRuntimeEnv;
  const core = {
    logging: { shouldLogVerbose: () => false },
    channel: {
      routing: {
        resolveAgentRoute: () => ({
          agentId: "agent-1",
          accountId: "work",
          sessionKey: "session-1",
        }),
      },
      session: {
        resolveStorePath: () => "/tmp/openclaw-googlechat-test",
        readSessionUpdatedAt: () => undefined,
        recordInboundSession: vi.fn(),
      },
      reply: {
        resolveEnvelopeFormatOptions: () => ({}),
        formatAgentEnvelope: ({ body }: { body: string }) => body,
        dispatchReplyWithBufferedBlockDispatcher: vi.fn(),
      },
      media: { saveMediaBuffer },
      inbound: { buildContext, run: runTurn },
    },
  } as unknown as GoogleChatCoreRuntime;
  return { buildContext, core, runTurn, runtime, saveMediaBuffer };
}

async function processAttachments(params: {
  event: GoogleChatEvent;
  harness: ReturnType<typeof createHarness>;
  mediaMaxMb?: number;
}) {
  await testing.processMessageWithPipeline({
    event: params.event,
    account,
    config: {},
    runtime: params.harness.runtime,
    core: params.harness.core,
    mediaMaxMb: params.mediaMaxMb ?? 10,
  });
}

function builtContext(harness: ReturnType<typeof createHarness>): BuiltContext {
  return harness.buildContext.mock.results[0]?.value as BuiltContext;
}

function ingestedMessage(harness: ReturnType<typeof createHarness>): IngestedMessage {
  const runParams = harness.runTurn.mock.calls[0]?.[0] as {
    adapter: { ingest: () => IngestedMessage };
  };
  return runParams.adapter.ingest();
}

beforeEach(() => {
  apiMocks.downloadGoogleChatMedia.mockReset();
  apiMocks.sendGoogleChatMessage.mockReset();
  accessMocks.applyGoogleChatInboundAccessPolicy.mockReset();
  accessMocks.applyGoogleChatInboundAccessPolicy.mockResolvedValue({
    ok: true,
    commandAuthorized: undefined,
    effectiveWasMentioned: undefined,
    groupBotLoopProtection: undefined,
    groupSystemPrompt: undefined,
  });
});

describe("googlechat monitor attachments", () => {
  it("materializes two attachments serially in message order with the configured byte cap", async () => {
    const harness = createHarness();
    apiMocks.downloadGoogleChatMedia
      .mockResolvedValueOnce({ buffer: Buffer.from("first"), contentType: "image/png" })
      .mockResolvedValueOnce({ buffer: Buffer.from("second"), contentType: "application/pdf" });
    harness.saveMediaBuffer
      .mockResolvedValueOnce({ path: "/tmp/first.png", contentType: "image/png" })
      .mockResolvedValueOnce({ path: "/tmp/second.pdf", contentType: "application/pdf" });

    await processAttachments({
      event: attachmentEvent({
        text: "keep this text",
        attachments: [uploadedAttachment("first"), uploadedAttachment("second", "application/pdf")],
      }),
      harness,
    });

    const maxBytes = 10 * 1024 * 1024;
    expect(apiMocks.downloadGoogleChatMedia.mock.calls).toEqual([
      [{ account, resourceName: "media/first", maxBytes }],
      [{ account, resourceName: "media/second", maxBytes }],
    ]);
    expect(harness.saveMediaBuffer).toHaveBeenNthCalledWith(
      1,
      Buffer.from("first"),
      "image/png",
      "inbound",
      maxBytes,
      "first.png",
    );
    expect(harness.saveMediaBuffer).toHaveBeenNthCalledWith(
      2,
      Buffer.from("second"),
      "application/pdf",
      "inbound",
      maxBytes,
      "second.pdf",
    );
    expect(harness.saveMediaBuffer.mock.invocationCallOrder[0]).toBeLessThan(
      apiMocks.downloadGoogleChatMedia.mock.invocationCallOrder[1] ?? 0,
    );
    expect(builtContext(harness)).toMatchObject({
      Body: "keep this text",
      BodyForAgent: "keep this text",
      RawBody: "keep this text",
      CommandBody: "keep this text",
      MediaPaths: ["/tmp/first.png", "/tmp/second.pdf"],
      MediaUrls: ["/tmp/first.png", "/tmp/second.pdf"],
      MediaTypes: ["image/png", "application/pdf"],
    });
  });

  it("keeps later media and marks agent context after a download failure", async () => {
    const harness = createHarness();
    apiMocks.downloadGoogleChatMedia
      .mockRejectedValueOnce(new Error("download unavailable"))
      .mockResolvedValueOnce({ buffer: Buffer.from("second"), contentType: "application/pdf" });
    harness.saveMediaBuffer.mockResolvedValueOnce({
      path: "/tmp/second.pdf",
      contentType: "application/pdf",
    });

    await processAttachments({
      event: attachmentEvent({
        text: "keep this text",
        attachments: [uploadedAttachment("first"), uploadedAttachment("second", "application/pdf")],
      }),
      harness,
    });

    const agentText = "keep this text\n\n[googlechat attachment unavailable]";
    expect(harness.runtime.error).toHaveBeenCalledWith(
      "[work] Google Chat attachment processing failed: Error: download unavailable",
    );
    expect(builtContext(harness)).toMatchObject({
      Body: agentText,
      BodyForAgent: agentText,
      RawBody: "keep this text",
      CommandBody: "keep this text",
      MediaPaths: ["/tmp/second.pdf"],
    });
    expect(ingestedMessage(harness)).toEqual({
      id: "spaces/DM/messages/attachments",
      timestamp: undefined,
      rawText: "keep this text",
      textForAgent: agentText,
      textForCommands: "keep this text",
      raw: expect.any(Object),
    });
  });

  it("keeps a media placeholder and later media after a save failure", async () => {
    const harness = createHarness();
    apiMocks.downloadGoogleChatMedia
      .mockResolvedValueOnce({ buffer: Buffer.from("first"), contentType: "image/png" })
      .mockResolvedValueOnce({ buffer: Buffer.from("second"), contentType: "application/pdf" });
    harness.saveMediaBuffer
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValueOnce({ path: "/tmp/second.pdf", contentType: "application/pdf" });

    await processAttachments({
      event: attachmentEvent({
        attachments: [uploadedAttachment("first"), uploadedAttachment("second", "application/pdf")],
      }),
      harness,
    });

    const agentText = "<media:attachment>\n\n[googlechat attachment unavailable]";
    expect(harness.runtime.error).toHaveBeenCalledWith(
      "[work] Google Chat attachment processing failed: Error: disk full",
    );
    expect(builtContext(harness)).toMatchObject({
      Body: agentText,
      BodyForAgent: agentText,
      RawBody: "<media:attachment>",
      CommandBody: "<media:attachment>",
      MediaPaths: ["/tmp/second.pdf"],
    });
    expect(ingestedMessage(harness)).toMatchObject({
      rawText: "<media:attachment>",
      textForAgent: agentText,
      textForCommands: "<media:attachment>",
    });
  });

  it("counts Drive-backed and missing data references as unavailable", async () => {
    const harness = createHarness();

    await processAttachments({
      event: attachmentEvent({
        text: "inspect these",
        attachments: [{ driveDataRef: { driveFileId: "drive-1" } }, { contentName: "missing" }],
      }),
      harness,
    });

    expect(apiMocks.downloadGoogleChatMedia).not.toHaveBeenCalled();
    expect(harness.saveMediaBuffer).not.toHaveBeenCalled();
    expect(builtContext(harness)).toMatchObject({
      Body: "inspect these\n\n[googlechat 2 attachments unavailable]",
      BodyForAgent: "inspect these\n\n[googlechat 2 attachments unavailable]",
      RawBody: "inspect these",
      CommandBody: "inspect these",
    });
    expect(builtContext(harness).MediaPaths).toBeUndefined();
  });

  it("replaces the optimistic placeholder when every attachment fails", async () => {
    const harness = createHarness();
    apiMocks.downloadGoogleChatMedia
      .mockRejectedValueOnce(new Error("first unavailable"))
      .mockRejectedValueOnce(new Error("second unavailable"));

    await processAttachments({
      event: attachmentEvent({
        attachments: [uploadedAttachment("first"), uploadedAttachment("second")],
      }),
      harness,
    });

    expect(builtContext(harness)).toMatchObject({
      Body: "[googlechat 2 attachments unavailable]",
      BodyForAgent: "[googlechat 2 attachments unavailable]",
      RawBody: "<media:attachment>",
      CommandBody: "<media:attachment>",
    });
    expect(builtContext(harness).MediaPaths).toBeUndefined();
    expect(ingestedMessage(harness)).toMatchObject({
      rawText: "<media:attachment>",
      textForAgent: "[googlechat 2 attachments unavailable]",
      textForCommands: "<media:attachment>",
    });
  });

  it("processes only the first 20 attachments and marks overflow unavailable", async () => {
    const harness = createHarness();
    const attachments = Array.from({ length: 21 }, (_, index) =>
      uploadedAttachment(`file-${index + 1}`),
    );
    apiMocks.downloadGoogleChatMedia.mockImplementation(async ({ resourceName }) => ({
      buffer: Buffer.from(resourceName),
      contentType: "image/png",
    }));
    harness.saveMediaBuffer.mockImplementation(
      async (
        _buffer: Buffer,
        contentType: string,
        _direction: string,
        _maxBytes: number,
        name: string,
      ) => ({
        path: `/tmp/${name}`,
        contentType,
      }),
    );

    await processAttachments({
      event: attachmentEvent({ text: "batch", attachments }),
      harness,
      mediaMaxMb: 3,
    });

    expect(apiMocks.downloadGoogleChatMedia).toHaveBeenCalledTimes(20);
    expect(harness.saveMediaBuffer).toHaveBeenCalledTimes(20);
    expect(apiMocks.downloadGoogleChatMedia).not.toHaveBeenCalledWith(
      expect.objectContaining({ resourceName: "media/file-21" }),
    );
    expect(apiMocks.downloadGoogleChatMedia.mock.calls).toEqual(
      expect.arrayContaining([
        [expect.objectContaining({ resourceName: "media/file-1", maxBytes: 3 * 1024 * 1024 })],
        [expect.objectContaining({ resourceName: "media/file-20", maxBytes: 3 * 1024 * 1024 })],
      ]),
    );
    expect(builtContext(harness)).toMatchObject({
      Body: "batch\n\n[googlechat attachment unavailable]",
      BodyForAgent: "batch\n\n[googlechat attachment unavailable]",
      RawBody: "batch",
      CommandBody: "batch",
      MediaPaths: Array.from({ length: 20 }, (_, index) => `/tmp/file-${index + 1}.png`),
    });
  });
});
