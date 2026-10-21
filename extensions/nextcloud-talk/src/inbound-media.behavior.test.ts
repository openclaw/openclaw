import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { MediaFetchError } from "openclaw/plugin-sdk/media-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginRuntime } from "../runtime-api.js";
import {
  createAccount,
  createAllowlistedAccount,
  createAttachment,
  createMessage,
  createRuntimeEnv,
  requireFirstMockArg,
} from "./inbound-media.test-fixtures.js";
import { handleNextcloudTalkInbound } from "./inbound.js";
import { setNextcloudTalkRuntime } from "./runtime.js";

const { pairingMock, groupPolicyMock, defaultPolicyMock, warnFallbackMock } = vi.hoisted(() => ({
  pairingMock: vi.fn(),
  groupPolicyMock: vi.fn(),
  defaultPolicyMock: vi.fn(),
  warnFallbackMock: vi.fn(),
}));

const sendMock = vi.hoisted(() => vi.fn());
const roomKindMock = vi.hoisted(() => vi.fn());
const mediaSourceMock = vi.hoisted(() => vi.fn());

vi.mock("../runtime-api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtime-api.js")>()),
  createChannelPairingController: pairingMock,
  resolveAllowlistProviderRuntimeGroupPolicy: groupPolicyMock,
  resolveDefaultGroupPolicy: defaultPolicyMock,
  warnMissingProviderGroupPolicyFallbackOnce: warnFallbackMock,
}));

vi.mock("./send.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./send.js")>()),
  sendMessageNextcloudTalk: sendMock,
}));

vi.mock("./inbound-media.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./inbound-media.js")>()),
  resolveNextcloudTalkAuthenticatedMediaSource: mediaSourceMock,
}));

vi.mock("./room-info.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./room-info.js")>()),
  resolveNextcloudTalkRoomKind: roomKindMock,
}));

function installInboundRuntime(coreRuntime = createPluginRuntimeMock()) {
  setNextcloudTalkRuntime(coreRuntime as unknown as PluginRuntime);
  pairingMock.mockReturnValue({
    readStoreForDmPolicy: vi.fn(async () => []),
    issueChallenge: vi.fn(),
  });
  const runtime = createRuntimeEnv();
  const receive = (
    message: Parameters<typeof createMessage>[0],
    account = createAllowlistedAccount(),
  ) =>
    handleNextcloudTalkInbound({
      message: createMessage(message),
      account,
      config: { channels: { "nextcloud-talk": {} } },
      runtime,
    });
  return { coreRuntime, runtime, receive };
}

function expectNonOutcome(
  runtime: ReturnType<typeof createRuntimeEnv>,
  reason: string,
  extra = "",
) {
  expect(runtime.log).toHaveBeenCalledWith(
    `nextcloud-talk: inbound media non-outcome reason=${reason} account=default message=msg-1 sender=users/user-1${extra}`,
  );
}

function mentionRoom(requireMention: boolean) {
  const coreRuntime = createPluginRuntimeMock();
  coreRuntime.channel.mentions.buildMentionRegexes = vi.fn(() => [/@openclaw/i]);
  coreRuntime.channel.mentions.matchesMentionPatterns = vi.fn(() => false);
  const result = installInboundRuntime(coreRuntime);
  roomKindMock.mockResolvedValue("group");
  const channelConfig = { rooms: { "room-group": { requireMention } } };
  return {
    ...result,
    account: createAccount({
      config: {
        ...channelConfig,
        dmPolicy: "pairing",
        allowFrom: [],
        mediaAllowFrom: ["user-1"],
        groupPolicy: "allowlist",
        groupAllowFrom: ["user-1"],
      },
    }),
    config: { channels: { "nextcloud-talk": channelConfig } },
  };
}

function expectTextContext(
  coreRuntime: ReturnType<typeof createPluginRuntimeMock>,
  message: Record<string, unknown>,
  noMedia = true,
) {
  expect(coreRuntime.channel.inbound.buildContext).toHaveBeenCalledWith(
    expect.objectContaining({ message: expect.objectContaining(message) }),
  );
  if (noMedia) {
    expect(
      requireFirstMockArg(vi.mocked(coreRuntime.channel.inbound.buildContext), "buildContext"),
    ).not.toHaveProperty("media");
  }
}

function unavailableText(text: string) {
  return {
    bodyForAgent: `${text}\n\n[Nextcloud Talk attachment unavailable]`,
    rawBody: text,
    commandBody: text,
  };
}

describe("nextcloud-talk inbound media behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    roomKindMock.mockResolvedValue("direct");
    defaultPolicyMock.mockReturnValue("allowlist");
    groupPolicyMock.mockReturnValue({
      groupPolicy: "allowlist",
      providerMissingFallbackApplied: false,
    });
    warnFallbackMock.mockReturnValue(undefined);
    mediaSourceMock.mockImplementation(async (params: { reference: { fileName: string } }) => ({
      ok: true,
      url: `https://cloud.example.com/remote.php/dav/files/test-user/Talk/${encodeURIComponent(params.reference.fileName)}`,
      origin: "https://cloud.example.com",
      hostname: "cloud.example.com",
      fileName: params.reference.fileName,
      authorization: "Basic redacted-test-credential",
    }));
  });

  it("admits and stages an attachment-only direct message", async () => {
    const { coreRuntime, receive } = installInboundRuntime();

    await receive({
      text: "",
      attachment: createAttachment("9006"),
    });

    expect(coreRuntime.channel.media.saveRemoteMedia).toHaveBeenCalledTimes(1);
    expect(coreRuntime.channel.inbound.buildContext).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.objectContaining({ bodyForAgent: "", rawBody: "" }),
        media: [{ path: "/tmp/test-media.jpg", contentType: "image/jpeg" }],
      }),
    );
  });

  it("does not invent a mention for an attachment-only mention-required room", async () => {
    const { coreRuntime, runtime, account, config } = mentionRoom(true);

    await handleNextcloudTalkInbound({
      message: createMessage({
        roomToken: "room-group",
        roomName: "Ops",
        isGroupChat: true,
        text: "",
        attachment: createAttachment("9007"),
      }),
      account,
      config,
      runtime,
    });

    expect(coreRuntime.channel.media.saveRemoteMedia).not.toHaveBeenCalled();
    expect(coreRuntime.channel.inbound.dispatchReply).not.toHaveBeenCalled();
    expect(runtime.log).toHaveBeenCalledWith("nextcloud-talk: drop room room-group (no mention)");
  });

  it("stages an attachment-only message in a mention-not-required room", async () => {
    const { coreRuntime, runtime, account, config } = mentionRoom(false);

    await handleNextcloudTalkInbound({
      message: createMessage({
        roomToken: "room-group",
        roomName: "Ops",
        isGroupChat: true,
        text: "",
        attachment: createAttachment("9013"),
      }),
      account,
      config,
      runtime,
    });

    expect(coreRuntime.channel.media.saveRemoteMedia).toHaveBeenCalledTimes(1);
    expect(coreRuntime.channel.inbound.buildContext).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.objectContaining({ bodyForAgent: "", rawBody: "", commandBody: "" }),
        media: [{ path: "/tmp/test-media.jpg", contentType: "image/jpeg" }],
      }),
    );
    expect(coreRuntime.channel.inbound.dispatchReply).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["image", "camera-shot.png", "image/png", 4_096, "inspect this image", "9010"],
    ["PDF", "receipt.pdf", "application/pdf", 8_192, "inspect this PDF", "9011"],
  ] as const)(
    "passes a staged %s path and type into inbound context",
    async (_kind, fileName, contentType, size, text, fileId) => {
      const path = `/tmp/${fileName}`;
      const coreRuntime = createPluginRuntimeMock();
      vi.mocked(coreRuntime.channel.media.saveRemoteMedia).mockResolvedValueOnce({
        id: fileName,
        path,
        size,
        contentType,
      });
      const { receive } = installInboundRuntime(coreRuntime);

      await receive({
        text,
        attachment: createAttachment(fileId, {
          name: fileName,
          mimeType: contentType,
          declaredSizeBytes: size,
        }),
      });

      expect(coreRuntime.channel.media.saveRemoteMedia).toHaveBeenCalledWith(
        expect.objectContaining({
          filePathHint: fileName,
          fallbackContentType: contentType,
          originalFilename: fileName,
        }),
      );
      expect(coreRuntime.channel.inbound.buildContext).toHaveBeenCalledWith(
        expect.objectContaining({
          media: [{ path, contentType }],
        }),
      );
      expect(coreRuntime.channel.inbound.dispatchReply).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    { label: "omitted", mediaAllowFrom: undefined },
    { label: "empty", mediaAllowFrom: [] },
    { label: "explicit nonmatch", mediaAllowFrom: ["other-user"] },
  ])(
    "logs $label media allowlist denial after normal admission without fetching",
    async ({ mediaAllowFrom }) => {
      const { coreRuntime, runtime, receive } = installInboundRuntime();

      await receive(
        {
          text: "please inspect this receipt",
          attachment: createAttachment("9001", { declaredSizeBytes: 24_576 }),
        },
        createAllowlistedAccount({ mediaAllowFrom }),
      );

      expect(coreRuntime.channel.media.saveRemoteMedia).not.toHaveBeenCalled();
      expectNonOutcome(runtime, "media_sender_not_allowlisted");
      expectTextContext(coreRuntime, {
        bodyForAgent: "please inspect this receipt",
        rawBody: "please inspect this receipt",
      });
      expect(
        JSON.stringify(
          requireFirstMockArg(
            coreRuntime.channel.inbound.buildContext as ReturnType<typeof vi.fn>,
            "Nextcloud Talk media-denied context",
          ),
        ),
      ).not.toContain("Nextcloud Talk attachment unavailable");
      expect(coreRuntime.channel.inbound.dispatchReply).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    { label: "omitted", mediaAllowFrom: undefined },
    { label: "empty", mediaAllowFrom: [] },
    { label: "explicit nonmatch", mediaAllowFrom: ["other-user"] },
  ])(
    "drops attachment-only media when the media allowlist is $label",
    async ({ mediaAllowFrom }) => {
      const { coreRuntime, runtime, receive } = installInboundRuntime();

      await receive(
        {
          text: "",
          attachment: createAttachment("9001", { declaredSizeBytes: 24_576 }),
        },
        createAllowlistedAccount({ mediaAllowFrom }),
      );

      expect(coreRuntime.channel.media.saveRemoteMedia).not.toHaveBeenCalled();
      expectNonOutcome(runtime, "media_sender_not_allowlisted");
      expect(coreRuntime.channel.inbound.buildContext).not.toHaveBeenCalled();
      expect(coreRuntime.channel.inbound.dispatch).not.toHaveBeenCalled();
      expect(coreRuntime.channel.inbound.dispatchReply).not.toHaveBeenCalled();
    },
  );

  it("rejects hide-download media before fetching", async () => {
    const { coreRuntime, runtime, receive } = installInboundRuntime();

    await receive({
      text: "private receipt",
      attachment: createAttachment("9002", {
        name: "private.pdf",
        hideDownload: true,
      }),
    });

    expect(coreRuntime.channel.media.saveRemoteMedia).not.toHaveBeenCalled();
    expectNonOutcome(runtime, "media_hidden_download");
    expectTextContext(coreRuntime, {
      ...unavailableText("private receipt"),
      body: expect.stringContaining("[Nextcloud Talk attachment unavailable]"),
    });
  });

  it("bounds missing attachment metadata before fetching", async () => {
    const { coreRuntime, runtime, receive } = installInboundRuntime();

    await receive({
      text: "caption survives",
      attachmentIssue: "media_missing_metadata",
    });

    expect(coreRuntime.channel.media.saveRemoteMedia).not.toHaveBeenCalled();
    expectNonOutcome(runtime, "media_missing_metadata");
    expectTextContext(coreRuntime, unavailableText("caption survives"));
  });

  it("keeps structured commands decoded when authorized media is unavailable", async () => {
    const hasControlCommand = vi.fn((body?: string) => body === "/status");
    const coreRuntime = createPluginRuntimeMock({
      channel: {
        text: { hasControlCommand },
        commands: { shouldHandleTextCommands: vi.fn(() => true) },
      },
    });
    const { receive } = installInboundRuntime(coreRuntime);
    const structuredCommand = '{"message":"/status","parameters":[]}';

    await receive({
      text: structuredCommand,
      attachmentIssue: "media_missing_metadata",
    });

    expect(hasControlCommand).toHaveBeenCalledWith("/status", expect.anything());
    expectTextContext(
      coreRuntime,
      { ...unavailableText(structuredCommand), commandBody: "/status" },
      false,
    );
    expect(coreRuntime.channel.inbound.dispatchReply).toHaveBeenCalledTimes(1);
  });

  it("rejects declared oversize media before fetching", async () => {
    const { coreRuntime, runtime, receive } = installInboundRuntime();

    await receive(
      {
        text: "large receipt",
        attachment: createAttachment("9003", {
          name: "large.pdf",
          declaredSizeBytes: 2 * 1024 * 1024,
        }),
      },
      createAllowlistedAccount({ mediaMaxMb: 1 }),
    );

    expect(coreRuntime.channel.media.saveRemoteMedia).not.toHaveBeenCalled();
    expectNonOutcome(runtime, "media_declared_oversize", " sizeBytes=2097152 maxBytes=1048576");
    expectTextContext(coreRuntime, unavailableText("large receipt"));
  });

  it("fails closed when the configured API account cannot resolve attachment access", async () => {
    mediaSourceMock.mockResolvedValueOnce({
      ok: false,
      reason: "media_auth_unavailable",
    });
    const { coreRuntime, runtime, receive } = installInboundRuntime();

    await receive({
      text: "inspect this",
      attachment: createAttachment("9004"),
    });

    expect(coreRuntime.channel.media.saveRemoteMedia).not.toHaveBeenCalled();
    expectNonOutcome(runtime, "media_auth_unavailable");
    expectTextContext(coreRuntime, unavailableText("inspect this"), false);
  });

  it.each([
    {
      label: "HTTP unavailable",
      error: new MediaFetchError(
        "http_error",
        "https://cloud.example.com/s/private-token returned secret-error-detail",
        { status: 404 },
      ),
      expectedLog:
        "nextcloud-talk: inbound media non-outcome reason=media_unavailable account=default message=msg-1 sender=users/user-1 status=404",
    },
    {
      label: "fetch timeout",
      error: new MediaFetchError(
        "fetch_failed",
        "timeout reading https://cloud.example.com/s/private-token secret-error-detail",
      ),
      expectedLog:
        "nextcloud-talk: inbound media non-outcome reason=media_fetch_failed account=default message=msg-1 sender=users/user-1",
    },
    {
      label: "staging failure",
      error: new Error("stage failed for private-token with secret-error-detail"),
      expectedLog:
        "nextcloud-talk: inbound media non-outcome reason=media_stage_failed account=default message=msg-1 sender=users/user-1",
    },
  ])("preserves caption and bounded diagnostics for $label", async ({ error, expectedLog }) => {
    const coreRuntime = createPluginRuntimeMock();
    vi.mocked(coreRuntime.channel.media.saveRemoteMedia).mockRejectedValueOnce(error);
    const { runtime, receive } = installInboundRuntime(coreRuntime);

    await receive({
      text: "inspect this sensitive receipt",
      attachment: createAttachment("9009"),
    });

    expect(runtime.log).toHaveBeenCalledWith(expectedLog);
    const serializedLogs = JSON.stringify(
      (runtime.log as unknown as ReturnType<typeof vi.fn>).mock.calls,
    );
    expect(serializedLogs).not.toContain("private-token");
    expect(serializedLogs).not.toContain("secret-error-detail");
    expect(serializedLogs).not.toContain("inspect this sensitive receipt");
    expectTextContext(coreRuntime, unavailableText("inspect this sensitive receipt"));
    expect(coreRuntime.channel.inbound.dispatchReply).toHaveBeenCalledTimes(1);
  });
});
