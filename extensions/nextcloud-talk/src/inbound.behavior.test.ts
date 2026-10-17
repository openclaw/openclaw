import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ChannelInboundTurnPlan } from "openclaw/plugin-sdk/channel-inbound";
import {
  createPluginRuntimeMock,
  createTestRegistry,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/channel-test-helpers";
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
import { handleNextcloudTalkInbound } from "./inbound.js";
import {
  withNextcloudTalkOutboundFixture,
  type NextcloudTalkOutboundFixture,
} from "./outbound-media.test-harness.js";
import { setNextcloudTalkRuntime } from "./runtime.js";
import type { CoreConfig, NextcloudTalkInboundMessage } from "./types.js";

const {
  createChannelPairingControllerMock,
  resolveAllowlistProviderRuntimeGroupPolicyMock,
  resolveDefaultGroupPolicyMock,
  warnMissingProviderGroupPolicyFallbackOnceMock,
} = vi.hoisted(() => {
  return {
    createChannelPairingControllerMock: vi.fn(),
    resolveAllowlistProviderRuntimeGroupPolicyMock: vi.fn(),
    resolveDefaultGroupPolicyMock: vi.fn(),
    warnMissingProviderGroupPolicyFallbackOnceMock: vi.fn(),
  };
});

const sendMessageNextcloudTalkMock = vi.hoisted(() => vi.fn());
const resolveNextcloudTalkRoomKindMock = vi.hoisted(() => vi.fn());

vi.mock("../runtime-api.js", async () => {
  const actual = await vi.importActual<typeof import("../runtime-api.js")>("../runtime-api.js");
  return {
    ...actual,
    createChannelPairingController: createChannelPairingControllerMock,
    resolveAllowlistProviderRuntimeGroupPolicy: resolveAllowlistProviderRuntimeGroupPolicyMock,
    resolveDefaultGroupPolicy: resolveDefaultGroupPolicyMock,
    warnMissingProviderGroupPolicyFallbackOnce: warnMissingProviderGroupPolicyFallbackOnceMock,
  };
});

vi.mock("./send.js", async (original) => ({
  ...(await original<typeof import("./send.js")>()),
  sendMessageNextcloudTalk: sendMessageNextcloudTalkMock,
}));

vi.mock("./room-info.js", async () => {
  const actual = await vi.importActual<typeof import("./room-info.js")>("./room-info.js");
  return {
    ...actual,
    resolveNextcloudTalkRoomKind: resolveNextcloudTalkRoomKindMock,
  };
});

function installRuntime(params?: {
  buildMentionRegexes?: () => RegExp[];
  hasControlCommand?: (body: string) => boolean;
  matchesMentionPatterns?: (body: string, regexes: RegExp[]) => boolean;
  shouldHandleTextCommands?: () => boolean;
}) {
  const runtime = {
    channel: {
      inbound: {
        ingress: createPluginRuntimeMock().channel.inbound.ingress,
        dispatchReply: vi.fn(async () => undefined),
      },
      pairing: {
        readAllowFromStore: vi.fn(async () => []),
        upsertPairingRequest: vi.fn(async () => ({ code: "123456", created: true })),
      },
      commands: {
        shouldHandleTextCommands: params?.shouldHandleTextCommands ?? vi.fn(() => false),
      },
      text: {
        hasControlCommand: params?.hasControlCommand ?? vi.fn(() => false),
      },
      mentions: {
        buildMentionRegexes: params?.buildMentionRegexes ?? vi.fn(() => []),
        matchesMentionPatterns: params?.matchesMentionPatterns ?? vi.fn(() => false),
      },
    },
  };
  setNextcloudTalkRuntime(runtime as unknown as PluginRuntime);
  return runtime;
}

function requireFirstMockArg(mock: ReturnType<typeof vi.fn>, label: string): unknown {
  const [call] = mock.mock.calls;
  if (!call) {
    throw new Error(`expected ${label}`);
  }
  return call[0];
}

function requireFirstSendMessageCall(): [unknown, unknown, unknown] {
  const [call] = sendMessageNextcloudTalkMock.mock.calls;
  if (!call) {
    throw new Error("expected Nextcloud Talk send call");
  }
  return call as [unknown, unknown, unknown];
}

function createAccount(
  config: ResolvedNextcloudTalkAccount["config"] = {},
): ResolvedNextcloudTalkAccount {
  return {
    accountId: "default",
    enabled: true,
    baseUrl: "https://cloud.example.com",
    secret: "secret",
    secretSource: "config",
    config: {
      dmPolicy: "pairing",
      allowFrom: [],
      groupPolicy: "allowlist",
      groupAllowFrom: [],
      ...config,
    },
  };
}

function installPairingController(readStoreForDmPolicy = vi.fn(), issueChallenge = vi.fn()) {
  createChannelPairingControllerMock.mockReturnValue({ readStoreForDmPolicy, issueChallenge });
}

function createMessage(
  overrides?: Partial<NextcloudTalkInboundMessage>,
): NextcloudTalkInboundMessage {
  return {
    messageId: "msg-1",
    roomToken: "room-1",
    roomName: "Room 1",
    senderId: "user-1",
    senderName: "Alice",
    text: "hello",
    mediaType: "text/plain",
    timestamp: Date.now(),
    isGroupChat: false,
    ...overrides,
  };
}

type AutomaticReplyFixture = NextcloudTalkOutboundFixture & { mediaUrl: string };
type ProviderReplyDelivery = ChannelInboundTurnPlan<"provider_message_sending">["delivery"];
type NativeReplyDelivery = ProviderReplyDelivery["deliverWithProviderMessageSending"];

function isProviderReplyDelivery(
  delivery: ChannelInboundTurnPlan["delivery"] | ProviderReplyDelivery,
): delivery is ProviderReplyDelivery {
  return (
    "deliverWithProviderMessageSending" in delivery &&
    typeof delivery.deliverWithProviderMessageSending === "function"
  );
}

// The dispatch mock exposes its last (core-managed) overload. Resolve the
// captured callback through both supported contracts for native/baseline proof.
function resolveReplyDelivery(
  delivery: ChannelInboundTurnPlan["delivery"] | ProviderReplyDelivery,
) {
  return isProviderReplyDelivery(delivery)
    ? delivery.deliverWithProviderMessageSending
    : delivery.deliver;
}

type AutomaticReplyContext = {
  fixture: AutomaticReplyFixture;
  controller: AbortController;
  onPlatformSendDispatch: ReturnType<typeof vi.fn<() => Promise<void>>>;
  deliver: (payload: ReplyPayload, kind: "final" | "block") => ReturnType<NativeReplyDelivery>;
};

// Capture synthetic assistant output at the inbound reply boundary; the shared
// outbound planner, scoped media loading, and native HTTP transport remain real.
async function withNativeAutomaticReply(
  run: (context: AutomaticReplyContext) => Promise<void>,
  options: { botOnly?: boolean } = {},
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
    const work = config.channels?.["nextcloud-talk"]?.accounts?.work;
    if (!work) {
      throw new Error("expected fixture API account");
    }
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
    // Existing pairing tests retain their text spy; native reply cases delegate
    // the spy to the real transport so the old URL fallback remains observable.
    const actual = await vi.importActual<typeof import("./send.js")>("./send.js");
    sendMessageNextcloudTalkMock.mockImplementation(actual.sendMessageNextcloudTalk);
    const controller = new AbortController();
    const onPlatformSendDispatch = vi.fn(async () => {});
    try {
      await handleNextcloudTalkInbound({
        message: createMessage({ roomToken: "allowed" }),
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
      const request = vi.mocked(core.channel.inbound.dispatch).mock.calls[0]?.[0];
      if (!request) {
        throw new Error("expected admitted automatic reply delivery");
      }
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
          const prepared = request.delivery.preparePayload
            ? await request.delivery.preparePayload(payload, info)
            : payload;
          if (prepared === null) {
            return { visibleReplySent: false };
          }
          // The old callback is deliberately executable for baseline controls:
          // the assertion must fail for missing native upload, not a new field.
          const deliver = resolveReplyDelivery(request.delivery);
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
    resolveNextcloudTalkRoomKindMock.mockResolvedValue("direct");
    resolveDefaultGroupPolicyMock.mockReturnValue("allowlist");
    resolveAllowlistProviderRuntimeGroupPolicyMock.mockReturnValue({
      groupPolicy: "allowlist",
      providerMissingFallbackApplied: false,
    });
    warnMissingProviderGroupPolicyFallbackOnceMock.mockReturnValue(undefined);
  });

  it("logs the drop when an inbound message has an empty body", async () => {
    const runtime = createRuntimeSpies();
    await handleNextcloudTalkInbound({
      message: createMessage({ text: "", mediaType: "application/pdf" }),
      account: createAccount(),
      config: { channels: { "nextcloud-talk": {} } } as CoreConfig,
      runtime,
    });

    expect(runtime.log).toHaveBeenCalledWith(
      "nextcloud-talk: drop empty message body (mediaType=application/pdf) target=user-1",
    );
    expect(sendMessageNextcloudTalkMock).not.toHaveBeenCalled();
  });

  it("issues a DM pairing challenge and sends the challenge text", async () => {
    const issueChallenge = vi.fn(
      async (params: { sendPairingReply: (text: string) => Promise<void> }) => {
        await params.sendPairingReply("Pair with code 123456");
      },
    );
    installPairingController(vi.fn(), issueChallenge);
    sendMessageNextcloudTalkMock.mockResolvedValue(undefined);

    const statusSink = vi.fn();
    await handleNextcloudTalkInbound({
      message: createMessage({ timestamp: 1_736_380_800_000 }),
      account: createAccount(),
      config: { channels: { "nextcloud-talk": {} } } as CoreConfig,
      runtime: createRuntimeSpies(),
      statusSink,
    });

    const challengeParams = requireFirstMockArg(
      issueChallenge,
      "Nextcloud Talk pairing challenge",
    ) as {
      meta?: { name?: string };
      senderId?: string;
      senderIdLine?: string;
    };
    expect(challengeParams.senderId).toBe("user-1");
    expect(challengeParams.senderIdLine).toBe("Your Nextcloud user id: user-1");
    expect(challengeParams.meta).toEqual({ name: "Alice" });
    expect(sendMessageNextcloudTalkMock).toHaveBeenCalledTimes(1);
    const sendArgs = requireFirstSendMessageCall();
    expect(sendArgs[0]).toBe("room-1");
    expect(sendArgs[1]).toBe("Pair with code 123456");
    expect(sendArgs[2]).toEqual({
      cfg: { channels: { "nextcloud-talk": {} } },
      accountId: "default",
    });
    expect(statusSink).toHaveBeenCalledWith({ lastInboundAt: 1_736_380_800_000 });
    const outboundStatus = statusSink.mock.calls
      .map(([status]) => status as { lastOutboundAt?: unknown })
      .find((status) => status.lastOutboundAt !== undefined);
    expect(typeof outboundStatus?.lastOutboundAt).toBe("number");
    expect(outboundStatus?.lastOutboundAt).toBeGreaterThanOrEqual(1_736_380_800_000);
  });

  it("drops unmentioned group traffic before dispatch", async () => {
    installRuntime({
      buildMentionRegexes: vi.fn(() => [/@openclaw/i]),
      matchesMentionPatterns: vi.fn(() => false),
    });
    installPairingController();
    resolveNextcloudTalkRoomKindMock.mockResolvedValue("group");
    const runtime = createRuntimeSpies();

    await handleNextcloudTalkInbound({
      message: createMessage({
        roomToken: "room-group",
        roomName: "Ops",
        isGroupChat: true,
      }),
      account: createAccount({ groupAllowFrom: ["user-1"] }),
      config: { channels: { "nextcloud-talk": {} } } as CoreConfig,
      runtime,
    });

    expect(sendMessageNextcloudTalkMock).not.toHaveBeenCalled();
    expect(runtime.log).toHaveBeenCalledWith("nextcloud-talk: drop room room-group (no mention)");
  });

  it.each([
    ["plain", "/help"],
    ["structured", JSON.stringify({ message: "/help", parameters: {} })],
  ])(
    "blocks %s group commands when room access allows chat but command access does not",
    async (_label, text) => {
      const buildMentionRegexes = vi.fn(() => [/@openclaw/i]);
      const coreRuntime = createPluginRuntimeMock({
        channel: {
          text: { hasControlCommand: vi.fn((body?: string) => body === "/help") },
          commands: { shouldHandleTextCommands: vi.fn(() => true) },
          mentions: { buildMentionRegexes },
        },
      });
      setNextcloudTalkRuntime(coreRuntime);
      installPairingController();
      resolveNextcloudTalkRoomKindMock.mockResolvedValue("group");
      const runtime = createRuntimeSpies();

      await handleNextcloudTalkInbound({
        message: createMessage({
          roomToken: "room-group",
          roomName: "Ops",
          isGroupChat: true,
          text,
        }),
        account: createAccount({
          rooms: { "room-group": { allowFrom: ["user-1"], requireMention: false } },
        }),
        config: { channels: { "nextcloud-talk": {} } } as CoreConfig,
        runtime,
      });

      expect(coreRuntime.channel.inbound.dispatchReply).not.toHaveBeenCalled();
      expect(buildMentionRegexes).not.toHaveBeenCalled();
      expect(runtime.log).toHaveBeenCalledWith(
        "nextcloud-talk: drop control command (unauthorized) target=user-1",
      );
    },
  );

  it.each([
    {
      label: "structured group command without mention",
      text: '{"message":"/help","parameters":{}}',
      command: "/help",
      group: true,
    },
  ])("keeps command and raw projections separate for $label", async ({ text, command, group }) => {
    const hasControlCommand = vi.fn((body?: string) => body?.startsWith("/") ?? false);
    const coreRuntime = createPluginRuntimeMock({
      channel: {
        text: { hasControlCommand },
        commands: { shouldHandleTextCommands: vi.fn(() => true) },
        mentions: {
          buildMentionRegexes: vi.fn(() => [/@openclaw/i]),
          matchesMentionPatterns: vi.fn(() => false),
        },
      },
    });
    setNextcloudTalkRuntime(coreRuntime);
    installPairingController(vi.fn(async () => []));
    resolveNextcloudTalkRoomKindMock.mockResolvedValue(group ? "group" : "direct");
    const account = createAccount({
      dmPolicy: "allowlist",
      allowFrom: ["user-1"],
      groupAllowFrom: ["user-1"],
      rooms: { "room-1": { requireMention: true } },
    });
    const config = { channels: { "nextcloud-talk": account.config } } as CoreConfig;

    await handleNextcloudTalkInbound({
      message: createMessage({ text, isGroupChat: group ?? false }),
      account,
      config,
      runtime: createRuntimeSpies(),
    });

    expect(hasControlCommand).toHaveBeenCalledWith(command, config);
    expect(coreRuntime.channel.inbound.dispatchReply).toHaveBeenCalledTimes(1);
    const assembledRequest = requireFirstMockArg(
      coreRuntime.channel.inbound.dispatchReply as ReturnType<typeof vi.fn>,
      "Nextcloud Talk assembled request",
    ) as { ctxPayload: Record<string, unknown>; replyPipeline?: unknown };
    expect(assembledRequest.replyPipeline).toEqual({});
    expect(assembledRequest.ctxPayload).toEqual(
      expect.objectContaining({
        CommandBody: command,
        BodyForCommands: command,
        RawBody: text.trim(),
        BodyForAgent: text.trim(),
        CommandAuthorized: true,
        ...(group ? { WasMentioned: false } : {}),
      }),
    );
  });

  it("binds durable ingress adoption into reply options", async () => {
    const coreRuntime = createPluginRuntimeMock();
    setNextcloudTalkRuntime(coreRuntime as unknown as PluginRuntime);
    installPairingController(vi.fn(async () => []));
    const lifecycle = {
      abortSignal: new AbortController().signal,
      onAdopted: vi.fn(async () => {}),
      onDeferred: vi.fn(),
      onAdoptionFinalizing: vi.fn(),
      onAbandoned: vi.fn(async () => {}),
    };

    await handleNextcloudTalkInbound({
      message: createMessage(),
      account: createAccount({ dmPolicy: "allowlist", allowFrom: ["user-1"] }),
      config: { channels: { "nextcloud-talk": {} } } as CoreConfig,
      runtime: createRuntimeSpies(),
      turnAdoptionLifecycle: lifecycle,
    });

    const request = requireFirstMockArg(
      coreRuntime.channel.inbound.dispatchReply as ReturnType<typeof vi.fn>,
      "Nextcloud Talk assembled request",
    ) as {
      replyOptions?: {
        turnAdoptionLifecycle?: {
          admission?: string;
          onAdopted?: () => void | Promise<void>;
        };
      };
    };
    expect(request.replyOptions?.turnAdoptionLifecycle).toEqual(
      expect.objectContaining({ admission: "exclusive", onAdopted: lifecycle.onAdopted }),
    );
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
    expect(sendMessageNextcloudTalkMock).not.toHaveBeenCalled();
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
        expect(upload?.url.pathname).toMatch(/^\/cloud\/remote.php\/dav\/files\/canonical-user\//);
        const shareRequests = fixture.requests.filter(({ url }) =>
          url.pathname.endsWith("/shares"),
        );
        expect(shareRequests).toHaveLength(1);
        const share = new URLSearchParams(shareRequests[0]!.body.toString());
        expect(share.get("shareType")).toBe("10");
        expect(share.get("shareWith")).toBe("allowed");
        expect(share.get("permissions")).toBe("1");
        expect(JSON.parse(share.get("talkMetaData") ?? "{}")).toEqual({ caption, replyTo: 41 });
        expect(result).toMatchObject({
          visibleReplySent: true,
          receipt: { platformMessageIds: ["42"] },
        });
        expect(fixture.requests.some(({ url }) => url.pathname.includes("/bot/"))).toBe(false);
        expect(
          fixture.requests.every(
            ({ authorization }) =>
              authorization ===
              `Basic ${Buffer.from("login-alias:synthetic-app-password").toString("base64")}`,
          ),
        ).toBe(true);
      });
    },
  );

  it.each([
    { kind: "final" as const, caption: "The report" },
    { kind: "block" as const, caption: "The report" },
    { kind: "final" as const, caption: "" },
  ])(
    "preserves a bot-only automatic $kind web link with caption '$caption'",
    async ({ kind, caption }) => {
      await withNativeAutomaticReply(
        async ({ fixture, deliver }) => {
          const mediaUrl = "https://example.com/report.pdf";
          const result = await deliver(
            { text: caption || undefined, mediaUrl, replyToId: "41" },
            kind,
          );
          expect(result).toMatchObject({
            visibleReplySent: true,
            receipt: { platformMessageIds: ["900"] },
          });
          expect(fixture.requests).toHaveLength(1);
          expect(fixture.requests[0]?.url.pathname).toBe(
            "/cloud/ocs/v2.php/apps/spreed/api/v1/bot/allowed/message",
          );
          expect(JSON.parse(fixture.requests[0]!.body.toString())).toEqual({
            message: `${caption}\n\nAttachment: ${mediaUrl}`.trim(),
            replyTo: "41",
          });
        },
        { botOnly: true },
      );
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

  it("keeps a warning-only automatic reply invisible after sanitation", async () => {
    await withNativeAutomaticReply(async ({ fixture, deliver }) => {
      await expect(
        deliver({ text: "⚠️ 🛠️ `search repos (agent)` failed" }, "final"),
      ).resolves.toMatchObject({ visibleReplySent: false });
      expect(fixture.requests).toEqual([]);
    });
  });
});
