import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { recordChannelBotPairLoopAndCheckSuppression } from "openclaw/plugin-sdk/channel-inbound";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import { MediaFetchError } from "openclaw/plugin-sdk/media-runtime";
import { beforeEach, expect, it, vi } from "vitest";
import { createRuntimeSpies } from "../../test-support/runtime-spies.js";
import type { ResolvedGoogleChatAccount } from "./accounts.js";
import { GoogleChatApiError } from "./api.js";
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

type EventProcessor = (
  event: GoogleChatEvent,
  target: Record<string, unknown>,
  turnAdoptionLifecycle?: GoogleChatIngressLifecycle,
) => Promise<void>;
const routingMocks = vi.hoisted(() => ({ processEvent: undefined as EventProcessor | undefined }));

const inboundMocks = vi.hoisted(() => ({
  buildEnvelope: vi.fn(({ body }: { body: string }) => body),
  resolveAgentRoute: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/channel-inbound")>();
  return {
    ...actual,
    createChannelInboundEnvelopeBuilderAsync: async () => inboundMocks.buildEnvelope,
  };
});

vi.mock("openclaw/plugin-sdk/routing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/routing")>()),
  resolveAgentRoute: inboundMocks.resolveAgentRoute,
}));

// mock-isolation: Network responses come only from the monitor fixture.
vi.mock("./api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api.js")>()),
  ...apiMocks,
}));
// mock-isolation: The fixture supplies access decisions without pairing state.
vi.mock("./monitor-access.js", () => accessMocks);

// mock-isolation: Capture ingress directly without installing HTTP webhook routes.
vi.mock("./monitor-routing.js", () => ({
  registerGoogleChatWebhookTarget: vi.fn(),
  setGoogleChatWebhookEventProcessor: vi.fn((processEvent: EventProcessor) => {
    routingMocks.processEvent = processEvent;
  }),
}));

beforeEach(() => {
  apiMocks.deleteGoogleChatMessage.mockReset();
  apiMocks.downloadGoogleChatMedia.mockReset();
  apiMocks.sendGoogleChatMessage.mockReset().mockResolvedValue(null);
  apiMocks.updateGoogleChatMessage.mockReset().mockResolvedValue({});
  accessMocks.applyGoogleChatInboundAccessPolicy.mockReset().mockResolvedValue({ ok: true });
  inboundMocks.buildEnvelope.mockReset().mockImplementation(({ body }: { body: string }) => body);
  inboundMocks.resolveAgentRoute
    .mockReset()
    .mockImplementation(({ accountId }: { accountId: string }) => ({
      agentId: "agent-1",
      accountId,
      sessionKey: "session-1",
    }));
});

function createHarness() {
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
  const dispatch = async (
    input: GoogleChatEvent | EventInput,
    {
      account = googleChatMediaTestAccount,
      config = {},
      runtime = createRuntimeSpies(),
      mediaMaxMb = 10,
      turnAdoptionLifecycle,
    }: {
      account?: ResolvedGoogleChatAccount;
      config?: Record<string, unknown>;
      runtime?: GoogleChatRuntimeEnv;
      mediaMaxMb?: number;
      turnAdoptionLifecycle?: GoogleChatIngressLifecycle;
    } = {},
  ) => {
    if (!routingMocks.processEvent) {
      throw new Error("Expected Google Chat webhook event processor registration");
    }
    await routingMocks.processEvent(
      "id" in input ? makeEvent(input) : input,
      { account, config, runtime, core, mediaMaxMb, path: "/googlechat" },
      turnAdoptionLifecycle,
    );
  };
  return { buildContext, core, runTurn, saveMediaBuffer, dispatch };
}

function readGoogleChatTestIngest(runTurn: ReturnType<typeof vi.fn>) {
  const runArg = runTurn.mock.calls[0]?.[0] as
    | { adapter?: { ingest?: () => TestIngest } }
    | undefined;
  return runArg?.adapter?.ingest?.();
}

type TestIngest = Partial<Record<"rawText" | "textForAgent" | "textForCommands", string>> & {
  timestamp?: number;
};

function makeAccount(
  config: ResolvedGoogleChatAccount["config"],
  accountId = "work",
): ResolvedGoogleChatAccount {
  return { accountId, enabled: true, config, credentialSource: "inline" };
}
const googleChatMediaTestAccount = makeAccount({ typingIndicator: "none" });

type EventInput = {
  id: string;
  text?: string;
  attachments?: NonNullable<GoogleChatEvent["message"]>["attachment"];
  space?: GoogleChatEvent["space"];
  sender?: NonNullable<GoogleChatEvent["message"]>["sender"];
  eventTime?: string;
};
function makeEvent(params: EventInput): GoogleChatEvent {
  return {
    type: "MESSAGE",
    space: params.space ?? { name: "spaces/MEDIA", type: "DM" },
    eventTime: params.eventTime,
    message: {
      name: `${params.space?.name ?? "spaces/MEDIA"}/messages/${params.id}`,
      text: params.text,
      sender: params.sender ?? { name: "users/alice", type: "HUMAN" },
      attachment: params.attachments,
    },
  };
}

function attachment(name: string, contentType = "application/pdf", contentName?: string) {
  return { contentType, contentName, attachmentDataRef: { resourceName: `media/${name}` } };
}

function messageFields(body: string) {
  return { body, bodyForAgent: body, rawBody: body, commandBody: body };
}

it("suppresses bot loops before creating typing messages", async () => {
  const eventTimeMs = Date.parse("2026-03-22T00:00:00.000Z");
  const accountId = `bot-loop-typing-${eventTimeMs}`;
  const conversationId = "spaces/LOOP";
  const senderId = "users/other-bot";
  const receiverId = "users/app";
  const { runTurn, dispatch } = createHarness();
  const account = makeAccount(
    {
      allowBots: true,
      botUser: receiverId,
      botLoopProtection: { maxEventsPerWindow: 1, windowSeconds: 60, cooldownSeconds: 60 },
      typingIndicator: "message",
    },
    accountId,
  );
  const event = makeEvent({
    id: "2",
    text: "loop",
    eventTime: "2026-03-22T00:00:00.001Z",
    space: { name: conversationId, type: "DM" },
    sender: { name: senderId, type: "BOT" },
  });
  recordChannelBotPairLoopAndCheckSuppression({
    scopeId: accountId,
    conversationId,
    senderId,
    receiverId,
    config: account.config.botLoopProtection,
    defaultEnabled: true,
    nowMs: eventTimeMs,
  });

  await dispatch(event, { account });

  expect(apiMocks.sendGoogleChatMessage).not.toHaveBeenCalled();
  expect(apiMocks.downloadGoogleChatMedia).not.toHaveBeenCalled();
  expect(runTurn).not.toHaveBeenCalled();
});

it("downloads every file in source order and preserves metadata-only positions", async () => {
  const { buildContext, dispatch, runTurn, saveMediaBuffer } = createHarness();
  apiMocks.downloadGoogleChatMedia
    .mockResolvedValueOnce({ buffer: Buffer.from("image"), contentType: "image/png" })
    .mockResolvedValueOnce({ buffer: Buffer.from("document"), contentType: "application/pdf" });
  saveMediaBuffer
    .mockResolvedValueOnce({ path: "/tmp/first.png", contentType: "image/png" })
    .mockResolvedValueOnce({ path: "/tmp/second.pdf", contentType: "application/pdf" });
  await dispatch({
    id: "downloaded",
    attachments: [
      attachment("first", "image/png", "first.png"),
      { contentType: "text/plain" },
      attachment("second", "application/pdf", "second.pdf"),
      { contentType: "text/plain" },
    ],
  });

  expect(
    apiMocks.downloadGoogleChatMedia.mock.calls.map(([params]) => params.resourceName),
  ).toEqual(["media/first", "media/second"]);
  const notice =
    "[Google Chat attachment unavailable: unsupported attachment source; upload the file directly]";
  expect(buildContext).toHaveBeenCalledWith(
    expect.objectContaining({
      message: messageFields(notice),
      media: [
        expect.objectContaining({ path: "/tmp/first.png", contentType: "image/png" }),
        expect.objectContaining({ contentType: "text/plain" }),
        expect.objectContaining({ path: "/tmp/second.pdf", contentType: "application/pdf" }),
        expect.objectContaining({ contentType: "text/plain" }),
      ],
    }),
  );
  expect(readGoogleChatTestIngest(runTurn)).toMatchObject({ textForAgent: notice });
});

it("continues after oversized files and emits their notice once", async () => {
  const { dispatch, runTurn, saveMediaBuffer } = createHarness();
  const runtime = createRuntimeSpies();
  const oversized = new MediaFetchError("max_bytes", "exceeds max bytes");
  apiMocks.downloadGoogleChatMedia
    .mockRejectedValueOnce(oversized)
    .mockRejectedValueOnce(oversized)
    .mockResolvedValueOnce({ buffer: Buffer.from("image"), contentType: "image/png" });
  await dispatch(
    {
      id: "oversized-first",
      attachments: [attachment("large-1"), attachment("large-2"), attachment("small", "image/png")],
    },
    { runtime },
  );

  expect(apiMocks.downloadGoogleChatMedia).toHaveBeenCalledTimes(3);
  expect(saveMediaBuffer).toHaveBeenCalledOnce();
  expect(readGoogleChatTestIngest(runTurn)).toMatchObject({
    textForAgent: "[Google Chat attachment too large; maximum 10 MB]",
  });
  expect(runtime.error).toHaveBeenCalledOnce();
});

it("honors an inbound media cap below one MiB", async () => {
  const { dispatch, runTurn, saveMediaBuffer } = createHarness();
  const buffer = Buffer.alloc(768 * 1024);
  apiMocks.downloadGoogleChatMedia.mockImplementation(
    async ({ maxBytes }: { maxBytes: number }) => {
      if (buffer.length > maxBytes) {
        throw new MediaFetchError("max_bytes", `Google Chat media exceeds max bytes (${maxBytes})`);
      }
      return { buffer, contentType: "application/pdf" };
    },
  );

  await dispatch(
    {
      id: "fractional-cap",
      text: "summarize this",
      attachments: [attachment("fractional-cap")],
    },
    { mediaMaxMb: 0.5 },
  );

  expect(apiMocks.downloadGoogleChatMedia).toHaveBeenCalledExactlyOnceWith({
    account: googleChatMediaTestAccount,
    resourceName: "media/fractional-cap",
    maxBytes: 512 * 1024,
  });
  expect(saveMediaBuffer).not.toHaveBeenCalled();
  expect(readGoogleChatTestIngest(runTurn)).toMatchObject({
    rawText: "summarize this\n\n[Google Chat attachment too large; maximum 0.5 MB]",
  });
});

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
  const { buildContext, dispatch, runTurn, saveMediaBuffer } = createHarness();
  const runtime = createRuntimeSpies();
  await dispatch(
    {
      id: "unsupported",
      text,
      attachments: [
        { contentType: "application/pdf", contentName: "private-file.pdf", driveDataRef },
      ],
    },
    { runtime },
  );

  const reason = driveDataRef
    ? "Google Drive files are not downloadable"
    : "unsupported attachment source";
  const notice = `[Google Chat attachment unavailable: ${reason}; upload the file directly]`;
  const expectedBody = text ? `${text}\n\n${notice}` : notice;
  expect(apiMocks.downloadGoogleChatMedia).not.toHaveBeenCalled();
  expect(saveMediaBuffer).not.toHaveBeenCalled();
  expect(buildContext).toHaveBeenCalledWith(
    expect.objectContaining({
      message: messageFields(expectedBody),
    }),
  );
  expect(runtime.error).toHaveBeenCalledExactlyOnceWith(`[work] ${notice}`);
  expect(readGoogleChatTestIngest(runTurn)).toMatchObject({ textForAgent: expectedBody });
});

it.each([
  new MediaFetchError("fetch_failed", "socket reset"),
  new GoogleChatApiError(403, "Google Chat API 403: Forbidden"),
])("keeps an unclassified fetch failure retryable: $name", async (error) => {
  const { dispatch, runTurn } = createHarness();
  apiMocks.downloadGoogleChatMedia
    .mockResolvedValueOnce({ buffer: Buffer.from("image"), contentType: "image/png" })
    .mockRejectedValueOnce(error);
  await expect(
    dispatch({
      id: "retryable",
      text: "please summarize this",
      attachments: [attachment("available", "image/png"), attachment("retryable")],
    }),
  ).rejects.toBe(error);
  expect(runTurn).not.toHaveBeenCalled();
});

it.each([
  {
    failure: "oversized",
    error: new MediaFetchError("max_bytes", "Google Chat media exceeds max bytes (10485760)"),
    notice: "[Google Chat attachment too large; maximum 10 MB]",
  },
  {
    failure: "missing",
    error: new GoogleChatApiError(404, "Google Chat API 404: Not Found"),
    notice: "[Google Chat attachment unavailable: file not found; upload the file directly]",
  },
])(
  "adopts a $failure attachment so the next message in its durable lane can run",
  async ({ error, notice, failure }) => {
    const created = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-googlechat-media-"));
    const stateDir = await fs.realpath(created);
    const queue = createChannelIngressQueueForTests<{ version: 1; rawEvent: string }>({
      channelId: "googlechat",
      accountId: "work",
      stateDir,
    });
    const { buildContext, dispatch, runTurn } = createHarness();
    const runtime = createRuntimeSpies();
    const receivedBodies: string[] = [];
    const receivedMedia: unknown[] = [];
    apiMocks.downloadGoogleChatMedia
      .mockResolvedValueOnce({ buffer: Buffer.from("image"), contentType: "image/png" })
      .mockRejectedValueOnce(error);
    runTurn.mockImplementation(
      async (params: { turnAdoptionLifecycle?: GoogleChatIngressLifecycle }) => {
        const context = buildContext.mock.calls.at(-1)?.[0] as {
          message: { rawBody: string };
          media?: unknown;
        };
        receivedBodies.push(context.message.rawBody);
        receivedMedia.push(context.media);
        await params.turnAdoptionLifecycle?.onAdopted();
      },
    );
    runtimeMocks.openChannelIngressQueue.mockReturnValue(queue);
    const ingress = createGoogleChatIngressMonitor({
      accountId: googleChatMediaTestAccount.accountId,
      runtime,
      dispatch: (event, turnAdoptionLifecycle) =>
        dispatch(event, { runtime, turnAdoptionLifecycle }),
    });
    const first = makeEvent({
      id: failure,
      text: "first caption",
      attachments: [attachment("available", "image/png"), attachment(failure)],
    });
    const second = makeEvent({ id: "follow-up", text: "next message" });

    ingress.start();
    try {
      await ingress.receive(first);
      await ingress.waitForIdle();
      await ingress.receive(second);
      await ingress.waitForIdle();

      expect(receivedBodies).toEqual([`first caption\n\n${notice}`, "next message"]);
      expect(receivedMedia[0]).toEqual([
        expect.objectContaining({ path: "/tmp/googlechat-first.png", contentType: "image/png" }),
        expect.objectContaining({ contentType: "application/pdf" }),
      ]);
      expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining(notice));
      expect(await queue.listPending({ limit: "all" })).toEqual([]);
      expect(await queue.listClaims()).toEqual([]);
    } finally {
      await ingress.stop();
      closeOpenClawStateDatabaseForTest();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  },
);

it.each([
  ["identity", undefined, undefined, "Alvin", "_Alvin is typing..._"],
  [
    "account over agent",
    "Workspace Bot",
    "Agent Name",
    "Identity Name",
    "_Workspace Bot is typing..._",
  ],
  ["agent over identity", undefined, "Agent Name", "Identity Name", "_Agent Name is typing..._"],
  ["fallback", " ", " ", " ", "_OpenClaw is typing..._"],
] as const)(
  "uses %s in the typing message",
  async (_name, accountName, name, identity, expectedText) => {
    const agent = { name, identity: { name: identity } };
    const { dispatch } = createHarness();
    const account = makeAccount(accountName === undefined ? {} : { name: accountName });
    await dispatch(
      {
        id: "1",
        text: "hello",
        space: { name: "spaces/IDENTITY", type: "DM" },
      },
      {
        account,
        config: { agents: { entries: { "agent-1": agent } } },
      },
    );

    expect(apiMocks.sendGoogleChatMessage).toHaveBeenCalledWith({
      account,
      space: "spaces/IDENTITY",
      text: expectedText,
      thread: undefined,
    });
  },
);

it("forwards bot sender status to the inbound context when allowBots is true", async () => {
  const { buildContext, dispatch } = createHarness();
  await dispatch(
    {
      id: "1",
      text: "hello",
      space: { name: "spaces/DM", type: "DM" },
      sender: { name: "users/sender", displayName: "Sender", type: "BOT" },
    },
    {
      account: makeAccount({ allowBots: true }),
    },
  );

  expect(buildContext).toHaveBeenCalledWith(
    expect.objectContaining({ sender: expect.objectContaining({ isBot: true }) }),
  );
});

it("drops invalid event timestamps from inbound runtime payloads", async () => {
  const { buildContext, dispatch, runTurn } = createHarness();
  const account = makeAccount({ typingIndicator: "message" });
  await dispatch(
    {
      id: "2",
      text: "hello",
      eventTime: "not-a-timestamp",
    },
    { account },
  );

  const noTimestamp = expect.objectContaining({ timestamp: undefined });
  expect(inboundMocks.buildEnvelope).toHaveBeenCalledWith(noTimestamp);
  expect(buildContext).toHaveBeenCalledWith(noTimestamp);
  expect(readGoogleChatTestIngest(runTurn)?.timestamp).toBeUndefined();
});
