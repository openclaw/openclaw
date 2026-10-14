// Googlechat tests cover monitor plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { recordChannelBotPairLoopAndCheckSuppression } from "openclaw/plugin-sdk/channel-inbound";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import { MediaFetchError } from "openclaw/plugin-sdk/media-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntimeSpies } from "../../test-support/runtime-spies.js";
import type { ResolvedGoogleChatAccount } from "./accounts.js";
import {
  createGoogleChatIngressMonitor,
  type GoogleChatIngressLifecycle,
} from "./monitor-ingress.js";
import type { GoogleChatCoreRuntime, GoogleChatRuntimeEnv } from "./monitor-types.js";
import "./monitor.js";
import type { GoogleChatEvent } from "./types.js";

const apiMocks = vi.hoisted(() => ({
  deleteGoogleChatMessage: vi.fn(),
  downloadGoogleChatMedia: vi.fn(),
  sendGoogleChatMessage: vi.fn(),
  updateGoogleChatMessage: vi.fn(),
}));

const accessMocks = vi.hoisted(() => ({
  applyGoogleChatInboundAccessPolicy: vi.fn(),
}));

const runtimeMocks = vi.hoisted(() => ({ openChannelIngressQueue: vi.fn() }));

vi.mock("./runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./runtime.js")>()),
  getGoogleChatRuntime: () => ({ state: runtimeMocks }),
}));

const routingMocks = vi.hoisted(() => ({
  processEvent: undefined as
    | ((
        event: GoogleChatEvent,
        target: Record<string, unknown>,
        turnAdoptionLifecycle?: GoogleChatIngressLifecycle,
      ) => Promise<void>)
    | undefined,
}));

const inboundMocks = vi.hoisted(() => ({
  buildEnvelope: vi.fn(({ body }: { body: string }) => body),
  resolveAgentRoute: vi.fn(),
  toInboundMediaFactsWithMetadata: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/channel-inbound")>();
  inboundMocks.toInboundMediaFactsWithMetadata.mockImplementation(
    actual.toInboundMediaFactsWithMetadata,
  );
  return {
    ...actual,
    createChannelInboundEnvelopeBuilderAsync: async () => inboundMocks.buildEnvelope,
    toInboundMediaFactsWithMetadata: inboundMocks.toInboundMediaFactsWithMetadata,
  };
});

vi.mock("openclaw/plugin-sdk/routing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/routing")>()),
  resolveAgentRoute: inboundMocks.resolveAgentRoute,
}));

vi.mock("./api.js", () => ({
  deleteGoogleChatMessage: apiMocks.deleteGoogleChatMessage,
  downloadGoogleChatMedia: apiMocks.downloadGoogleChatMedia,
  sendGoogleChatMessage: apiMocks.sendGoogleChatMessage,
  updateGoogleChatMessage: apiMocks.updateGoogleChatMessage,
}));

vi.mock("./monitor-access.js", () => ({
  applyGoogleChatInboundAccessPolicy: accessMocks.applyGoogleChatInboundAccessPolicy,
}));

vi.mock("./monitor-routing.js", () => ({
  registerGoogleChatWebhookTarget: vi.fn(),
  setGoogleChatWebhookEventProcessor: vi.fn(
    (
      processEvent: (
        event: GoogleChatEvent,
        target: Record<string, unknown>,
        turnAdoptionLifecycle?: GoogleChatIngressLifecycle,
      ) => Promise<void>,
    ) => {
      routingMocks.processEvent = processEvent;
    },
  ),
}));

beforeEach(() => {
  apiMocks.deleteGoogleChatMessage.mockReset();
  apiMocks.downloadGoogleChatMedia.mockReset();
  apiMocks.sendGoogleChatMessage.mockReset().mockResolvedValue(null);
  apiMocks.updateGoogleChatMessage.mockReset().mockResolvedValue({});
  accessMocks.applyGoogleChatInboundAccessPolicy.mockReset();
  inboundMocks.buildEnvelope.mockReset().mockImplementation(({ body }: { body: string }) => body);
  inboundMocks.resolveAgentRoute
    .mockReset()
    .mockImplementation(({ accountId }: { accountId: string }) => ({
      agentId: "agent-1",
      accountId,
      sessionKey: "session-1",
    }));
  inboundMocks.toInboundMediaFactsWithMetadata.mockClear();
});

function createInboundClassificationHarness() {
  const buildContext = vi.fn((payload: unknown) => payload);
  const runTurn = vi.fn();
  const saveMediaBuffer = vi.fn(async () => ({
    path: "/tmp/googlechat-first.png",
    contentType: "image/png",
  }));
  const core = {
    logging: { shouldLogVerbose: () => false },
    channel: {
      inbound: { buildContext, run: runTurn },
      media: { saveMediaBuffer },
    },
  } as unknown as GoogleChatCoreRuntime;
  return { buildContext, core, runTurn, saveMediaBuffer };
}

function readGoogleChatTestIngest(runTurn: ReturnType<typeof vi.fn>) {
  const runArg = runTurn.mock.calls[0]?.[0] as
    | { adapter?: { ingest?: () => Record<string, string> } }
    | undefined;
  return runArg?.adapter?.ingest?.();
}

const googleChatMediaTestAccount: ResolvedGoogleChatAccount = {
  accountId: "work",
  enabled: true,
  config: { typingIndicator: "none" },
  credentialSource: "inline",
};

function createGoogleChatMediaTestEvent(params: {
  id: string;
  text?: string;
  attachments?: NonNullable<GoogleChatEvent["message"]>["attachment"];
}): GoogleChatEvent {
  return {
    type: "MESSAGE",
    space: { name: "spaces/MEDIA", type: "DM" },
    message: {
      name: `spaces/MEDIA/messages/${params.id}`,
      ...(params.text === undefined ? {} : { text: params.text }),
      sender: { name: "users/alice", type: "HUMAN" },
      ...(params.attachments ? { attachment: params.attachments } : {}),
    },
  };
}

function allowGoogleChatMediaSender(commandAuthorized?: boolean) {
  accessMocks.applyGoogleChatInboundAccessPolicy.mockResolvedValue({
    ok: true,
    commandAuthorized,
    effectiveWasMentioned: undefined,
    groupBotLoopProtection: undefined,
    groupSystemPrompt: undefined,
  });
}

async function processGoogleChatTestEvent(params: {
  event: GoogleChatEvent;
  account: ResolvedGoogleChatAccount;
  config?: Record<string, unknown>;
  runtime?: GoogleChatRuntimeEnv;
  core: GoogleChatCoreRuntime;
  mediaMaxMb?: number;
  turnAdoptionLifecycle?: GoogleChatIngressLifecycle;
}): Promise<void> {
  if (!routingMocks.processEvent) {
    throw new Error("Expected Google Chat webhook event processor registration");
  }
  await routingMocks.processEvent(
    params.event,
    {
      account: params.account,
      config: params.config ?? {},
      runtime: params.runtime ?? createRuntimeSpies(),
      core: params.core,
      mediaMaxMb: params.mediaMaxMb ?? 10,
      path: "/googlechat",
    },
    params.turnAdoptionLifecycle,
  );
}

describe("googlechat monitor bot loop protection", () => {
  it("suppresses bot loops before creating typing messages", async () => {
    const eventTimeMs = Date.parse("2026-03-22T00:00:00.000Z");
    const accountId = `bot-loop-typing-${eventTimeMs}`;
    const conversationId = "spaces/LOOP";
    const senderId = "users/other-bot";
    const receiverId = "users/app";
    const runTurn = vi.fn();
    const core = {
      logging: { shouldLogVerbose: () => false },
      channel: {
        inbound: { run: runTurn },
      },
    } as unknown as GoogleChatCoreRuntime;
    const runtime = createRuntimeSpies() satisfies GoogleChatRuntimeEnv;
    const account = {
      accountId,
      config: {
        allowBots: true,
        botUser: receiverId,
        botLoopProtection: { maxEventsPerWindow: 1, windowSeconds: 60, cooldownSeconds: 60 },
        typingIndicator: "message",
      },
      credentialSource: "inline",
    } as ResolvedGoogleChatAccount;
    const event = {
      type: "MESSAGE",
      eventTime: "2026-03-22T00:00:00.001Z",
      space: { name: conversationId, type: "DM" },
      message: {
        name: "spaces/LOOP/messages/2",
        text: "loop",
        sender: { name: senderId, type: "BOT" },
      },
    } satisfies GoogleChatEvent;

    allowGoogleChatMediaSender();
    recordChannelBotPairLoopAndCheckSuppression({
      scopeId: accountId,
      conversationId,
      senderId,
      receiverId,
      config: account.config.botLoopProtection,
      defaultEnabled: true,
      nowMs: eventTimeMs,
    });

    await processGoogleChatTestEvent({
      event,
      account,
      runtime,
      core,
    });

    expect(apiMocks.sendGoogleChatMessage).not.toHaveBeenCalled();
    expect(apiMocks.downloadGoogleChatMedia).not.toHaveBeenCalled();
    expect(runTurn).not.toHaveBeenCalled();
  });
});

describe("googlechat monitor inbound space classification", () => {
  it.each([1, 9])(
    "downloads only the first file and accounts for %i additional attachments",
    async (additionalCount) => {
      const { buildContext, core, runTurn, saveMediaBuffer } = createInboundClassificationHarness();
      apiMocks.downloadGoogleChatMedia.mockResolvedValue({
        buffer: Buffer.from("image"),
        contentType: "image/png",
      });
      allowGoogleChatMediaSender();

      await processGoogleChatTestEvent({
        event: createGoogleChatMediaTestEvent({
          id: "downloaded",
          attachments: [
            {
              contentType: "image/png",
              contentName: "first.png",
              attachmentDataRef: { resourceName: "media/first" },
            },
            ...Array.from({ length: additionalCount }, (_, index) => ({
              contentType: "application/pdf",
              contentName: `additional-${index}.pdf`,
              attachmentDataRef: { resourceName: `media/additional-${index}` },
            })),
          ],
        }),
        account: googleChatMediaTestAccount,
        core,
      });

      expect(accessMocks.applyGoogleChatInboundAccessPolicy).toHaveBeenCalledWith(
        expect.objectContaining({ rawBody: "" }),
      );
      expect(saveMediaBuffer).toHaveBeenCalledOnce();
      expect(apiMocks.downloadGoogleChatMedia).toHaveBeenCalledExactlyOnceWith({
        account: expect.objectContaining({ accountId: "work" }),
        resourceName: "media/first",
        maxBytes: 10 * 1024 * 1024,
      });
      const expectedBody = additionalCount
        ? `[Google Chat: ${additionalCount} additional ${additionalCount === 1 ? "attachment was" : "attachments were"} not processed; only the first attachment is supported]`
        : "";
      expect(buildContext).toHaveBeenCalledWith(
        expect.objectContaining({
          message: {
            body: expectedBody,
            bodyForAgent: expectedBody,
            rawBody: expectedBody,
            commandBody: expectedBody,
          },
          media: [
            expect.objectContaining({
              path: "/tmp/googlechat-first.png",
              url: "/tmp/googlechat-first.png",
              contentType: "image/png",
            }),
            ...Array.from({ length: additionalCount }, () =>
              expect.objectContaining({ contentType: "application/pdf" }),
            ),
          ],
        }),
      );
      expect(readGoogleChatTestIngest(runTurn)).toMatchObject({
        rawText: expectedBody,
        textForAgent: expectedBody,
        textForCommands: expectedBody,
      });
    },
  );

  it.each([
    {
      name: "Drive file without a caption",
      text: "",
      driveDataRef: { driveFileId: "private-drive-file" },
    },
    {
      name: "attachment without a data reference",
      text: "summarize this",
      driveDataRef: undefined,
    },
  ])("explains an unsupported $name without downloading it", async ({ text, driveDataRef }) => {
    const { buildContext, core, runTurn, saveMediaBuffer } = createInboundClassificationHarness();
    const runtime = createRuntimeSpies();
    allowGoogleChatMediaSender();

    await processGoogleChatTestEvent({
      event: createGoogleChatMediaTestEvent({
        id: "unsupported",
        text,
        attachments: [
          { contentType: "application/pdf", contentName: "private-file.pdf", driveDataRef },
        ],
      }),
      account: googleChatMediaTestAccount,
      runtime,
      core,
    });

    const reason = driveDataRef
      ? "Google Drive files are not downloadable"
      : "unsupported attachment source";
    const notice = `[Google Chat attachment unavailable: ${reason}; upload the file directly]`;
    const expectedBody = text ? `${text}\n\n${notice}` : notice;
    expect(apiMocks.downloadGoogleChatMedia).not.toHaveBeenCalled();
    expect(saveMediaBuffer).not.toHaveBeenCalled();
    expect(buildContext).toHaveBeenCalledWith(
      expect.objectContaining({
        message: {
          body: expectedBody,
          bodyForAgent: expectedBody,
          rawBody: expectedBody,
          commandBody: expectedBody,
        },
      }),
    );
    expect(runtime.error).toHaveBeenCalledExactlyOnceWith(`[work] ${notice}`);
    expect(readGoogleChatTestIngest(runTurn)).toMatchObject({ textForAgent: expectedBody });
  });

  it("keeps a transient fetch failure retryable", async () => {
    const error = new MediaFetchError("fetch_failed", "socket reset");
    const { core, runTurn } = createInboundClassificationHarness();
    apiMocks.downloadGoogleChatMedia.mockRejectedValue(error);
    allowGoogleChatMediaSender();

    await expect(
      processGoogleChatTestEvent({
        event: createGoogleChatMediaTestEvent({
          id: "retryable",
          text: "please summarize this",
          attachments: [
            {
              contentType: "application/pdf",
              attachmentDataRef: { resourceName: "media/retryable" },
            },
          ],
        }),
        account: googleChatMediaTestAccount,
        core,
      }),
    ).rejects.toBe(error);
    expect(runTurn).not.toHaveBeenCalled();
  });

  it("adopts an oversized attachment so the next message in its durable lane can run", async () => {
    const created = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-googlechat-oversized-"));
    const stateDir = await fs.realpath(created);
    const queue = createChannelIngressQueueForTests<{ version: 1; rawEvent: string }>({
      channelId: "googlechat",
      accountId: "work",
      stateDir,
    });
    const { buildContext, core, runTurn } = createInboundClassificationHarness();
    const runtime = createRuntimeSpies();
    const account = googleChatMediaTestAccount;
    const receivedBodies: string[] = [];
    apiMocks.downloadGoogleChatMedia.mockRejectedValueOnce(
      new MediaFetchError("max_bytes", "Google Chat media exceeds max bytes (10485760)"),
    );
    allowGoogleChatMediaSender();
    runTurn.mockImplementation(
      async (params: { turnAdoptionLifecycle?: GoogleChatIngressLifecycle }) => {
        const context = buildContext.mock.calls.at(-1)?.[0] as { message: { rawBody: string } };
        receivedBodies.push(context.message.rawBody);
        await params.turnAdoptionLifecycle?.onAdopted();
      },
    );
    runtimeMocks.openChannelIngressQueue.mockReturnValue(queue);
    const ingress = createGoogleChatIngressMonitor({
      accountId: account.accountId,
      runtime,
      dispatch: async (event, turnAdoptionLifecycle) => {
        await processGoogleChatTestEvent({
          event,
          account,
          runtime,
          core,
          turnAdoptionLifecycle,
        });
      },
    });
    const first = createGoogleChatMediaTestEvent({
      id: "oversized",
      text: "first caption",
      attachments: [
        {
          contentType: "application/pdf",
          attachmentDataRef: { resourceName: "media/oversized" },
        },
      ],
    });
    const second = createGoogleChatMediaTestEvent({ id: "follow-up", text: "next message" });

    ingress.start();
    try {
      await ingress.receive(first);
      await ingress.waitForIdle();
      await ingress.receive(second);
      await ingress.waitForIdle();

      expect(receivedBodies).toEqual([
        "first caption\n\n[Google Chat attachment too large; maximum 10 MB]",
        "next message",
      ]);
      expect(await queue.listPending({ limit: "all" })).toEqual([]);
      expect(await queue.listClaims()).toEqual([]);
    } finally {
      await ingress.stop();
      closeOpenClawStateDatabaseForTest();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it.each([
    {
      name: "the agent identity name",
      accountName: undefined,
      agent: { identity: { name: "Alvin" } },
      expectedText: "_Alvin is typing..._",
    },
    {
      name: "the account name before agent names",
      accountName: "Workspace Bot",
      agent: { name: "Agent Name", identity: { name: "Identity Name" } },
      expectedText: "_Workspace Bot is typing..._",
    },
    {
      name: "the agent name before its identity name",
      accountName: undefined,
      agent: { name: "Agent Name", identity: { name: "Identity Name" } },
      expectedText: "_Agent Name is typing..._",
    },
    {
      name: "the generic fallback when names are empty",
      accountName: " ",
      agent: { name: " ", identity: { name: " " } },
      expectedText: "_OpenClaw is typing..._",
    },
  ])("uses $name in the typing message", async ({ accountName, agent, expectedText }) => {
    const { core } = createInboundClassificationHarness();
    const account = {
      accountId: "work",
      config: accountName === undefined ? {} : { name: accountName },
      credentialSource: "inline",
    } as ResolvedGoogleChatAccount;
    const event = {
      type: "MESSAGE",
      space: { name: "spaces/IDENTITY", type: "DM" },
      message: {
        name: "spaces/IDENTITY/messages/1",
        text: "hello",
        sender: { name: "users/alice", displayName: "Alice", type: "HUMAN" },
      },
    } satisfies GoogleChatEvent;

    allowGoogleChatMediaSender();

    await processGoogleChatTestEvent({
      event,
      account,
      config: { agents: { entries: { "agent-1": agent } } },
      core,
    });

    expect(apiMocks.sendGoogleChatMessage).toHaveBeenCalledWith({
      account,
      space: "spaces/IDENTITY",
      text: expectedText,
      thread: undefined,
    });
  });
});

describe("googlechat monitor sender bot status", () => {
  function botStatusEvent(senderType: "BOT" | "HUMAN", messageId: string): GoogleChatEvent {
    return {
      type: "MESSAGE",
      space: { name: "spaces/DM", type: "DM" },
      message: {
        name: `spaces/DM/messages/${messageId}`,
        text: "hello",
        sender: { name: "users/sender", displayName: "Sender", type: senderType },
      },
    } satisfies GoogleChatEvent;
  }

  it("forwards bot sender status to the inbound context when allowBots is true", async () => {
    const { buildContext, core } = createInboundClassificationHarness();
    allowGoogleChatMediaSender();

    await processGoogleChatTestEvent({
      event: botStatusEvent("BOT", "1"),
      account: {
        accountId: "work",
        config: { allowBots: true },
        credentialSource: "inline",
      } as ResolvedGoogleChatAccount,
      core,
    });

    expect(buildContext).toHaveBeenCalledWith(
      expect.objectContaining({ sender: expect.objectContaining({ isBot: true }) }),
    );
  });
});

describe("googlechat monitor direct messages", () => {
  it("drops invalid event timestamps from inbound runtime payloads", async () => {
    const { buildContext, core, runTurn } = createInboundClassificationHarness();
    const runtime = createRuntimeSpies() satisfies GoogleChatRuntimeEnv;
    const account = {
      accountId: "work",
      config: {
        typingIndicator: "message",
      },
      credentialSource: "inline",
    } as ResolvedGoogleChatAccount;
    const event = {
      type: "MESSAGE",
      eventTime: "not-a-timestamp",
      space: { name: "spaces/DM", type: "DM" },
      message: {
        name: "spaces/DM/messages/2",
        text: "hello",
        sender: { name: "users/alice", displayName: "Alice", type: "HUMAN" },
      },
    } satisfies GoogleChatEvent;

    allowGoogleChatMediaSender();

    await processGoogleChatTestEvent({
      event,
      account,
      runtime,
      core,
    });

    expect(inboundMocks.buildEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({ timestamp: undefined }),
    );
    expect(buildContext).toHaveBeenCalledWith(expect.objectContaining({ timestamp: undefined }));
    const runArg = runTurn.mock.calls[0]?.[0] as
      | { adapter?: { ingest?: () => { timestamp?: number } } }
      | undefined;
    expect(runArg?.adapter?.ingest?.().timestamp).toBeUndefined();
  });
});
