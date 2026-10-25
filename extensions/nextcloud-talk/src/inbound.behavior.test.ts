import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ChannelInboundTurnPlan } from "openclaw/plugin-sdk/channel-inbound";
import {
  createPluginRuntimeMock,
  createTestRegistry,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntimeSpies } from "../../test-support/runtime-spies.js";
import { nextcloudTalkPlugin } from "../channel-plugin-api.js";
import type { PluginRuntime } from "../runtime-api.js";
import { resolveNextcloudTalkAccount, type ResolvedNextcloudTalkAccount } from "./accounts.js";
import {
  createAccount as createFixtureAccount,
  createMessage,
  requireFirstMockArg,
} from "./inbound-media.test-fixtures.js";
import { handleNextcloudTalkInbound } from "./inbound.js";
import {
  withNextcloudTalkOutboundFixture,
  type NextcloudTalkOutboundFixture,
} from "./outbound-media.test-harness.js";
import { setNextcloudTalkRuntime } from "./runtime.js";
import type { CoreConfig } from "./types.js";

const mocks = vi.hoisted(() => ({
  pairing: vi.fn(),
  groupPolicy: vi.fn(),
  defaultPolicy: vi.fn(),
  warn: vi.fn(),
  send: vi.fn(),
  roomKind: vi.fn(),
}));

vi.mock("../runtime-api.js", async () => {
  const actual = await vi.importActual<typeof import("../runtime-api.js")>("../runtime-api.js");
  return {
    ...actual,
    createChannelPairingController: mocks.pairing,
    resolveAllowlistProviderRuntimeGroupPolicy: mocks.groupPolicy,
    resolveDefaultGroupPolicy: mocks.defaultPolicy,
    warnMissingProviderGroupPolicyFallbackOnce: mocks.warn,
  };
});

// mock-isolation: inbound fixtures must not send replies to a real Talk server.
vi.mock("./send.js", async (original) => ({
  ...(await original<typeof import("./send.js")>()),
  sendMessageNextcloudTalk: mocks.send,
}));

vi.mock("./room-info.js", async () => {
  const actual = await vi.importActual<typeof import("./room-info.js")>("./room-info.js");
  return {
    ...actual,
    resolveNextcloudTalkRoomKind: mocks.roomKind,
  };
});

function installRuntime() {
  const runtime = {
    channel: {
      inbound: {
        ingress: createPluginRuntimeMock().channel.inbound.ingress,
        dispatch: vi.fn(async () => undefined),
      },
      pairing: {
        readAllowFromStore: vi.fn(async () => []),
        upsertPairingRequest: vi.fn(async () => ({ code: "123456", created: true })),
      },
      commands: { shouldHandleTextCommands: vi.fn(() => false) },
      text: { hasControlCommand: vi.fn(() => false) },
      mentions: {
        buildMentionRegexes: vi.fn(() => []),
        matchesMentionPatterns: vi.fn(() => false),
      },
    },
  };
  setNextcloudTalkRuntime(runtime as unknown as PluginRuntime);
}

function installCommandRuntime(
  hasControlCommand: (body?: string) => boolean,
  mentions: Partial<PluginRuntime["channel"]["mentions"]> = {},
) {
  const runtime = createPluginRuntimeMock({
    channel: {
      text: { hasControlCommand },
      commands: { shouldHandleTextCommands: vi.fn(() => true) },
      mentions: { buildMentionRegexes: vi.fn(() => [/@openclaw/i]), ...mentions },
    },
  });
  setNextcloudTalkRuntime(runtime);
  return runtime;
}

function createAccount(config: ResolvedNextcloudTalkAccount["config"] = {}) {
  return createFixtureAccount({ config: { ...createFixtureAccount().config, ...config } });
}

function installPairingController(readStoreForDmPolicy = vi.fn(), issueChallenge = vi.fn()) {
  mocks.pairing.mockReturnValue({ readStoreForDmPolicy, issueChallenge });
}

const defaultConfig = { channels: { "nextcloud-talk": {} } } as CoreConfig;
type InboundOptions = Parameters<typeof handleNextcloudTalkInbound>[0];
function inbound(overrides: Partial<InboundOptions> = {}) {
  return handleNextcloudTalkInbound({
    message: createMessage(),
    account: createAccount(),
    config: defaultConfig,
    runtime: createRuntimeSpies(),
    ...overrides,
  });
}
async function allowedInbound(overrides: Partial<InboundOptions> = {}) {
  const runtime = createPluginRuntimeMock();
  setNextcloudTalkRuntime(runtime);
  installPairingController(vi.fn(async () => []));
  await inbound({
    account: createAccount({ dmPolicy: "allowlist", allowFrom: ["user-1"] }),
    ...overrides,
  });
  return dispatched(runtime);
}
function dispatched(runtime: ReturnType<typeof createPluginRuntimeMock>) {
  return expectDefined(
    vi.mocked(runtime.channel.inbound.dispatch).mock.calls[0]?.[0],
    "Nextcloud Talk assembled request",
  );
}

type AutomaticReplyFixture = NextcloudTalkOutboundFixture & { mediaUrl: string };
type ProviderReplyDelivery = ChannelInboundTurnPlan<"provider_message_sending">["delivery"];
type NativeReplyDelivery = ProviderReplyDelivery["deliverWithProviderMessageSending"];
type ProviderReplyDispatch = (
  request: ChannelInboundTurnPlan<"provider_message_sending">,
) => ReturnType<PluginRuntime["channel"]["inbound"]["dispatch"]>;

type AutomaticReplyContext = {
  fixture: AutomaticReplyFixture;
  controller: AbortController;
  onPlatformSendDispatch: ReturnType<typeof vi.fn<() => Promise<void>>>;
  deliver: (payload: ReplyPayload, kind: "final" | "block") => ReturnType<NativeReplyDelivery>;
};

// Capture assistant output; outbound planning, scoped media loading and HTTP remain real.
async function withNativeAutomaticReply(
  run: (context: AutomaticReplyContext) => Promise<void>,
  options: {
    botOnly?: boolean;
    quote?: { id: string; senderId: string; senderName: string; body: string };
  } = {},
) {
  await withNextcloudTalkOutboundFixture(async (fixture) => {
    const stateDir = path.join(fixture.directory, "state");
    const workspace = path.join(fixture.directory, "agent-workspace");
    await mkdir(stateDir);
    await mkdir(workspace);
    const mediaUrl = path.join(workspace, "automatic-report.pdf");
    await writeFile(mediaUrl, fixture.bytes);
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const config = structuredClone(fixture.ctx.cfg) as CoreConfig;
    config.agents = { defaults: { workspace }, entries: { main: {} } };
    const work = expectDefined(
      config.channels?.["nextcloud-talk"]?.accounts?.work,
      "fixture account",
    );
    work.dmPolicy = "allowlist";
    work.allowFrom = ["user-1"];
    if (options.botOnly) {
      delete work.apiUser;
      delete work.apiPassword;
      delete work.apiPasswordFile;
    }
    const core = createPluginRuntimeMock();
    vi.mocked(core.state.resolveStateDir).mockReturnValue(stateDir);
    vi.mocked(core.channel.session.resolveStorePath).mockReturnValue(
      path.join(stateDir, "agents", "main", "sessions.json"),
    );
    setNextcloudTalkRuntime(core);
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "nextcloud-talk",
          plugin: nextcloudTalkPlugin,
          source: "nextcloud-talk-native-reply-test",
          origin: "bundled",
        },
      ]),
    );
    installPairingController(vi.fn(async () => []));
    const actual = await vi.importActual<typeof import("./send.js")>("./send.js");
    mocks.send.mockImplementation(actual.sendMessageNextcloudTalk);
    const controller = new AbortController();
    const onPlatformSendDispatch = vi.fn(async () => {});
    try {
      await handleNextcloudTalkInbound({
        message: {
          ...createMessage({ roomToken: "allowed" }),
          ...(options.quote ? { quote: options.quote } : {}),
        },
        account: resolveNextcloudTalkAccount({ cfg: config, accountId: "work" }),
        config,
        runtime: createRuntimeSpies(),
        turnAdoptionLifecycle: {
          abortSignal: controller.signal,
          onAdopted: async () => {},
          onDeferred: () => {},
          onAdoptionFinalizing: () => {},
          onAbandoned: async () => {},
        },
      });
      const request = expectDefined(
        vi.mocked<ProviderReplyDispatch>(core.channel.inbound.dispatch).mock.calls[0]?.[0],
        "automatic reply delivery",
      );
      const prepare = expectDefined(request.delivery.preparePayload, "reply preparation");
      const deliver = expectDefined(
        request.delivery.deliverWithProviderMessageSending,
        "native delivery",
      );
      await run({
        fixture: Object.assign(fixture, { mediaUrl }),
        controller,
        onPlatformSendDispatch,
        deliver: async (payload, kind) => {
          const info = {
            kind,
            onPlatformSendDispatch,
            assertPlatformSendAuthorized: () => controller.signal.throwIfAborted(),
          };
          const prepared = await prepare(payload, info);
          if (prepared === null) {
            return { visibleReplySent: false };
          }
          return await deliver(prepared, info);
        },
      });
    } finally {
      await closeOpenClawStateDatabaseAsync();
      closeOpenClawStateDatabaseForTest();
      setActivePluginRegistry(createTestRegistry([]));
      vi.unstubAllEnvs();
    }
  });
}

describe("nextcloud-talk inbound behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installRuntime();
    mocks.roomKind.mockResolvedValue("direct");
    mocks.defaultPolicy.mockReturnValue("allowlist");
    mocks.groupPolicy.mockReturnValue({
      groupPolicy: "allowlist",
      providerMissingFallbackApplied: false,
    });
    mocks.warn.mockReturnValue(undefined);
  });

  it("keeps quoted context separate from current command and reply targets", async () => {
    const message = {
      ...createMessage({ text: "What about this?" }),
      quote: {
        id: "quoted-parent",
        senderId: "users/quoted-author",
        senderName: "Quoted author",
        body: "UNSEEN_QUOTED_CONTEXT /status @openclaw",
      },
    };
    const request = await allowedInbound({ message });
    expect(request.ctxPayload.ReplyChain).toEqual([
      {
        messageId: "quoted-parent",
        senderId: "users/quoted-author",
        sender: "Quoted author",
        body: "UNSEEN_QUOTED_CONTEXT /status @openclaw",
        isQuote: true,
      },
    ]);
    expect(request.ctxPayload.RawBody).toBe("What about this?");
    expect(request.ctxPayload.BodyForCommands).toBe("What about this?");
    expect(request.ctxPayload.ReplyToId).toBeUndefined();
    expect(request.ctxPayload.ReplyToIdFull).toBeUndefined();
    expect(request.ctxPayload.MessageSid).toBe(message.messageId);
  });

  it.each([
    { mode: "all" as const, visible: true },
    { mode: "allowlist" as const, visible: false },
    { mode: "allowlist_quote" as const, visible: true },
  ])("honors $mode visibility for a quoted group sender", async ({ mode, visible }) => {
    mocks.roomKind.mockResolvedValue("group");
    const account = createAccount({
      groupAllowFrom: ["user-1"],
      rooms: { "room-1": { requireMention: false } },
    });
    const message = {
      ...createMessage({ isGroupChat: true, text: "Current message" }),
      quote: { id: "parent", senderId: "users/other", senderName: "Other", body: "Quoted" },
    };
    const request = await allowedInbound({
      message,
      account,
      config: {
        channels: {
          defaults: { contextVisibility: mode },
          "nextcloud-talk": account.config,
        },
      },
    });
    expect(request.ctxPayload.ReplyChain?.[0]?.body).toBe(visible ? "Quoted" : undefined);
    expect(request.ctxPayload.SenderId).toBe("user-1");
  });

  it("does not count a quoted mention as addressing the current message", async () => {
    mocks.roomKind.mockResolvedValue("group");
    const core = installCommandRuntime((body) => body?.startsWith("/") ?? false, {
      matchesMentionPatterns: (body) => /@openclaw/i.test(body),
    });
    installPairingController(vi.fn(async () => []));
    const message = {
      ...createMessage({ isGroupChat: true, text: "Current message" }),
      quote: { id: "parent", senderId: "user-1", senderName: "Alice", body: "@openclaw /status" },
    };
    await inbound({
      message,
      account: createAccount({
        groupAllowFrom: ["user-1"],
        rooms: { "room-1": { requireMention: true } },
      }),
    });
    expect(core.channel.inbound.dispatch).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it.each([
    { senderId: "users/bob", roomAllowFrom: undefined, visible: true },
    { senderId: "users/outsider", roomAllowFrom: undefined, visible: false },
    { senderId: "users/bob", roomAllowFrom: ["users/alice"], visible: false },
  ])(
    "applies access-group quote visibility for $senderId (room=$roomAllowFrom)",
    async ({ senderId, roomAllowFrom, visible }) => {
      mocks.roomKind.mockResolvedValue("group");
      const account = createAccount({
        groupPolicy: "allowlist",
        groupAllowFrom: ["accessGroup:operators"],
        rooms: { "room-1": { requireMention: false, allowFrom: roomAllowFrom } },
      });
      const request = await allowedInbound({
        account,
        message: {
          ...createMessage({
            senderId: "users/alice",
            senderName: "Alice",
            isGroupChat: true,
            text: "What about this?",
          }),
          quote: {
            id: "parent",
            senderId,
            senderName: "Quoted author",
            body: "Group member quote",
          },
        },
        config: {
          accessGroups: {
            operators: {
              type: "message.senders",
              members: { "nextcloud-talk": ["users/alice", "users/bob"] },
            },
          },
          channels: {
            defaults: { contextVisibility: "allowlist" },
            "nextcloud-talk": account.config,
          },
        },
      });
      expect(request.ctxPayload.SenderId).toBe("users/alice");
      expect(request.ctxPayload.ReplyChain?.[0]?.body).toBe(
        visible ? "Group member quote" : undefined,
      );
      expect(request.ctxPayload.ReplyToId).toBeUndefined();
    },
  );

  it("issues a DM pairing challenge and sends the challenge text", async () => {
    const issueChallenge = vi.fn(
      async (params: { sendPairingReply: (text: string) => Promise<void> }) => {
        await params.sendPairingReply("Pair with code 123456");
      },
    );
    installPairingController(vi.fn(), issueChallenge);
    mocks.send.mockResolvedValue(undefined);

    const statusSink = vi.fn();
    await inbound({
      message: createMessage({ timestamp: 1_736_380_800_000 }),
      statusSink,
    });

    expect(requireFirstMockArg(issueChallenge, "Nextcloud Talk pairing challenge")).toEqual(
      expect.objectContaining({
        senderId: "user-1",
        senderIdLine: "Your Nextcloud user id: user-1",
        meta: { name: "Alice" },
      }),
    );
    expect(mocks.send).toHaveBeenCalledExactlyOnceWith("room-1", "Pair with code 123456", {
      cfg: defaultConfig,
      accountId: "default",
    });
    expect(statusSink).toHaveBeenCalledWith({ lastInboundAt: 1_736_380_800_000 });
    const outboundStatus = statusSink.mock.calls
      .map(([status]) => status as { lastOutboundAt?: unknown })
      .find((status) => status.lastOutboundAt !== undefined);
    expect(typeof outboundStatus?.lastOutboundAt).toBe("number");
    expect(outboundStatus?.lastOutboundAt).toBeGreaterThanOrEqual(1_736_380_800_000);
  });

  it.each([
    {
      message: { text: "", mediaType: "application/pdf" },
      account: {},
      command: false,
      log: "nextcloud-talk: drop empty message body (mediaType=application/pdf) target=user-1",
    },
    {
      message: { isGroupChat: true, text: "/help" },
      account: { rooms: { "room-1": { allowFrom: ["user-1"], requireMention: false } } },
      command: true,
      log: "nextcloud-talk: drop control command (unauthorized) target=user-1",
    },
    {
      message: { isGroupChat: true, text: JSON.stringify({ message: "/help", parameters: {} }) },
      account: { rooms: { "room-1": { allowFrom: ["user-1"], requireMention: false } } },
      command: true,
      log: "nextcloud-talk: drop control command (unauthorized) target=user-1",
    },
  ])("drops before delivery: $log", async ({ message, account, command, log }) => {
    let core: PluginRuntime | undefined;
    if (message.isGroupChat) {
      mocks.roomKind.mockResolvedValue("group");
      installPairingController();
      if (command) {
        core = installCommandRuntime(vi.fn((body?: string) => body === "/help"));
      }
    }
    const runtime = createRuntimeSpies();
    await inbound({ message: createMessage(message), account: createAccount(account), runtime });
    expect(mocks.send).not.toHaveBeenCalled();
    expect(runtime.log).toHaveBeenCalledWith(log);
    if (core) {
      expect(core.channel.inbound.dispatch).not.toHaveBeenCalled();
      expect(core.channel.mentions.buildMentionRegexes).not.toHaveBeenCalled();
    }
  });

  it("keeps command and raw projections separate for structured group commands without mention", async () => {
    const text = '{"message":"/help","parameters":{}}';
    const command = "/help";
    const hasControlCommand = vi.fn((body?: string) => body?.startsWith("/") ?? false);
    const coreRuntime = installCommandRuntime(hasControlCommand, {
      matchesMentionPatterns: vi.fn(() => false),
    });
    installPairingController(vi.fn(async () => []));
    mocks.roomKind.mockResolvedValue("group");
    const account = createAccount({
      dmPolicy: "allowlist",
      allowFrom: ["user-1"],
      groupAllowFrom: ["user-1"],
      rooms: { "room-1": { requireMention: true } },
    });
    const config = { channels: { "nextcloud-talk": account.config } } as CoreConfig;

    await inbound({
      message: createMessage({ text, isGroupChat: true }),
      account,
      config,
    });

    expect(hasControlCommand).toHaveBeenCalledWith(command, config);
    expect(coreRuntime.channel.inbound.dispatch).toHaveBeenCalledTimes(1);
    expect(dispatched(coreRuntime)).toMatchObject({
      replyPipeline: {},
      ctxPayload: {
        CommandBody: command,
        BodyForCommands: command,
        RawBody: text.trim(),
        BodyForAgent: text.trim(),
        CommandAuthorized: true,
        WasMentioned: false,
      },
    });
  });

  it("sanitizes inbound replies while preserving native delivery fields", async () => {
    const coreRuntime = createPluginRuntimeMock();
    setNextcloudTalkRuntime(coreRuntime);
    installPairingController(vi.fn(async () => []));

    const config = { channels: { "nextcloud-talk": {} } } as CoreConfig;
    await handleNextcloudTalkInbound({
      message: createMessage(),
      account: createAccount({ dmPolicy: "allowlist", allowFrom: ["user-1"] }),
      config,
      runtime: createRuntimeSpies(),
    });

    const request = vi.mocked(coreRuntime.channel.inbound.dispatch).mock.calls[0]?.[0];
    const preparePayload = request?.delivery.preparePayload;
    if (!preparePayload) {
      throw new Error("expected Nextcloud Talk reply preparation");
    }
    const info = { kind: "final" as const };
    const mediaOnlyPayload = { mediaUrl: "https://example.com/a.png" };
    expect(await preparePayload(mediaOnlyPayload, info)).toBe(mediaOnlyPayload);
    expect(
      await preparePayload(
        {
          text: "Done.\n⚠️ 🛠️ `search repos (agent)` failed",
          mediaUrls: ["https://example.com/a.png"],
          replyToId: "41",
        },
        info,
      ),
    ).toEqual({
      text: "Done.",
      mediaUrls: ["https://example.com/a.png"],
      replyToId: "41",
    });
    expect(await preparePayload({ text: "⚠️ 🛠️ `search repos (agent)` failed" }, info)).toEqual({
      text: "",
    });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("binds durable ingress adoption into reply options", async () => {
    const lifecycle = {
      abortSignal: new AbortController().signal,
      onAdopted: vi.fn(async () => {}),
      onDeferred: vi.fn(),
      onAdoptionFinalizing: vi.fn(),
      onAbandoned: vi.fn(async () => {}),
    };

    const request = await allowedInbound({ turnAdoptionLifecycle: lifecycle });
    expect(request.replyOptions?.turnAdoptionLifecycle).toMatchObject({
      admission: "exclusive",
      onAdopted: lifecycle.onAdopted,
    });
  });

  it.each([
    { kind: "final" as const, caption: "The report" },
    { kind: "block" as const, caption: "The report" },
    { kind: "final" as const, caption: "" },
  ])(
    "uploads an automatic $kind reply with caption '$caption' through native delivery",
    async ({ kind, caption }) => {
      await withNativeAutomaticReply(async ({ fixture, deliver }) => {
        const result = await deliver(
          {
            text: caption ? `${caption}\n⚠️ 🛠️ \`search repos (agent)\` failed` : undefined,
            mediaUrl: fixture.mediaUrl,
            replyToId: "41",
          },
          kind,
        );
        const upload = fixture.requests.find(({ method }) => method === "PUT");
        expect(upload?.body).toEqual(fixture.bytes);
        const shareRequests = fixture.requests.filter(({ url }) =>
          url.pathname.endsWith("/shares"),
        );
        expect(shareRequests).toHaveLength(1);
        const share = new URLSearchParams(shareRequests[0]!.body.toString());
        expect(JSON.parse(share.get("talkMetaData") ?? "{}")).toEqual({ caption, replyTo: 41 });
        expect(result).toMatchObject({
          visibleReplySent: true,
          receipt: { platformMessageIds: ["42"] },
        });
      });
    },
  );

  it("preserves ordered bot-only automatic links and caption through the shared planner", async () => {
    await withNativeAutomaticReply(
      async ({ fixture, deliver }) => {
        const urls = ["https://example.com/first.pdf", "https://example.com/second.pdf"];
        const result = await deliver(
          { text: "The reports", mediaUrls: urls, replyToId: "41" },
          "final",
        );
        expect(result).toMatchObject({ visibleReplySent: true });
        expect(fixture.requests).toHaveLength(2);
        expect(fixture.requests.map((request) => JSON.parse(request.body.toString()))).toEqual([
          { message: `The reports\n\nAttachment: ${urls[0]}`, replyTo: "41" },
          { message: `Attachment: ${urls[1]}`, replyTo: "41" },
        ]);
        expect(
          fixture.requests.every((request) =>
            request.url.pathname.endsWith("/bot/allowed/message"),
          ),
        ).toBe(true);
      },
      { botOnly: true },
    );
  });

  it.each(["final", "block"] as const)(
    "retains the first bot-only $kind link receipt when a later link fails",
    async (kind) => {
      await withNativeAutomaticReply(
        async ({ fixture, deliver }) => {
          let posts = 0;
          fixture.respond = (request, response) => {
            if (!request.url.pathname.endsWith("/bot/allowed/message") || ++posts !== 2) {
              return false;
            }
            response.writeHead(500);
            response.end();
            return true;
          };
          await expect(
            deliver(
              {
                text: "The reports",
                mediaUrls: ["https://example.com/first.pdf", "https://example.com/second.pdf"],
              },
              kind,
            ),
          ).rejects.toMatchObject({
            deliveryResult: { visibleReplySent: true, receipt: { platformMessageIds: ["900"] } },
          });
          expect(fixture.requests).toHaveLength(2);
          expect(
            fixture.requests.every((request) =>
              request.url.pathname.endsWith("/bot/allowed/message"),
            ),
          ).toBe(true);
        },
        { botOnly: true },
      );
    },
  );

  it("does not upload an automatic reply from outside its agent workspace", async () => {
    await withNativeAutomaticReply(async ({ fixture, deliver }) => {
      await expect(deliver({ mediaUrl: fixture.ctx.mediaUrl }, "final")).rejects.toThrow();
      expect(fixture.requests.some(({ method }) => method === "PUT" || method === "MKCOL")).toBe(
        false,
      );
    });
  });

  it("cancels a nonfinal automatic attachment before platform dispatch", async () => {
    await withNativeAutomaticReply(
      async ({ fixture, deliver, controller, onPlatformSendDispatch }) => {
        controller.abort(new Error("reply stopped"));
        await expect(deliver({ mediaUrl: fixture.mediaUrl }, "block")).rejects.toThrow();
        expect(fixture.requests).toEqual([]);
        expect(onPlatformSendDispatch).not.toHaveBeenCalled();
      },
    );
  });

  it.each([
    { kind: "final" as const, replyToId: undefined, expectedReply: undefined },
    { kind: "block" as const, replyToId: undefined, expectedReply: undefined },
    { kind: "final" as const, replyToId: "41", expectedReply: 41 },
  ])(
    "preserves $kind delivery targeting with quoted context ($replyToId)",
    async ({ kind, replyToId, expectedReply }) => {
      await withNativeAutomaticReply(
        async ({ fixture, deliver }) => {
          await deliver({ text: "Current answer", mediaUrl: fixture.mediaUrl, replyToId }, kind);
          const share = fixture.requests.find(({ url }) => url.pathname.endsWith("/shares"));
          const body = new URLSearchParams(share?.body.toString());
          expect(JSON.parse(body.get("talkMetaData") ?? "{}").replyTo).toBe(expectedReply);
        },
        {
          quote: {
            id: "40",
            senderId: "users/quoted",
            senderName: "Quoted author",
            body: "Earlier message",
          },
        },
      );
    },
  );

  it("keeps a warning-only automatic reply invisible after sanitation", async () => {
    await withNativeAutomaticReply(async ({ fixture, deliver }) => {
      await expect(
        deliver({ text: "⚠️ 🛠️ `search repos (agent)` failed" }, "final"),
      ).resolves.toMatchObject({ visibleReplySent: false });
      expect(fixture.requests).toEqual([]);
    });
  });
});
