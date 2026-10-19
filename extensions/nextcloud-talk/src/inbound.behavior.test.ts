import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntimeSpies } from "../../test-support/runtime-spies.js";
import type { OutboundReplyPayload, PluginRuntime } from "../runtime-api.js";
import type { ResolvedNextcloudTalkAccount } from "./accounts.js";
import {
  createAccount as createFixtureAccount,
  createMessage,
  requireFirstMockArg,
} from "./inbound-media.test-fixtures.js";
import { handleNextcloudTalkInbound } from "./inbound.js";
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
vi.mock("./send.js", () => ({
  sendMessageNextcloudTalk: mocks.send,
}));

vi.mock("./room-info.js", async () => {
  const actual = await vi.importActual<typeof import("./room-info.js")>("./room-info.js");
  return {
    ...actual,
    resolveNextcloudTalkRoomKind: mocks.roomKind,
  };
});

function installRuntime(mentionRegexes: RegExp[] = []) {
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
      commands: { shouldHandleTextCommands: vi.fn(() => false) },
      text: { hasControlCommand: vi.fn(() => false) },
      mentions: {
        buildMentionRegexes: vi.fn(() => mentionRegexes),
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
    vi.mocked(runtime.channel.inbound.dispatchReply).mock.calls[0]?.[0],
    "Nextcloud Talk assembled request",
  );
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
      message: { isGroupChat: true },
      account: { groupAllowFrom: ["user-1"] },
      command: false,
      log: "nextcloud-talk: drop room room-1 (no mention)",
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
      } else {
        installRuntime([/@openclaw/i]);
      }
    }
    const runtime = createRuntimeSpies();
    await inbound({ message: createMessage(message), account: createAccount(account), runtime });
    expect(mocks.send).not.toHaveBeenCalled();
    expect(runtime.log).toHaveBeenCalledWith(log);
    if (core) {
      expect(core.channel.inbound.dispatchReply).not.toHaveBeenCalled();
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
    expect(coreRuntime.channel.inbound.dispatchReply).toHaveBeenCalledTimes(1);
    expect(dispatched(coreRuntime)).toEqual(
      expect.objectContaining({
        replyPipeline: {},
        ctxPayload: expect.objectContaining({
          CommandBody: command,
          BodyForCommands: command,
          RawBody: text.trim(),
          BodyForAgent: text.trim(),
          CommandAuthorized: true,
          WasMentioned: false,
        }),
      }),
    );
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
    expect(request.replyOptions?.turnAdoptionLifecycle).toEqual(
      expect.objectContaining({ admission: "exclusive", onAdopted: lifecycle.onAdopted }),
    );
  });

  it("sanitizes inbound replies before local delivery while preserving transport fields", async () => {
    mocks.send.mockResolvedValue(undefined);
    const { delivery } = await allowedInbound();
    const preparePayload = expectDefined(delivery.preparePayload, "reply payload preparation");
    const prepare = async (payload: OutboundReplyPayload) =>
      expectDefined(await preparePayload(payload, { kind: "final" }), "prepared reply payload");
    const deliver = (payload: OutboundReplyPayload) => delivery.deliver(payload, { kind: "final" });

    const mediaOnlyPayload = { mediaUrl: "https://example.com/a.png" };
    expect(await prepare(mediaOnlyPayload)).toBe(mediaOnlyPayload);

    const preparedPayload = await prepare({
      text: "Done.\n⚠️ 🛠️ `search repos (agent)` failed",
      mediaUrls: ["https://example.com/a.png"],
      replyToId: "reply-1",
    });
    expect(preparedPayload).toEqual({
      text: "Done.",
      mediaUrls: ["https://example.com/a.png"],
      replyToId: "reply-1",
    });
    await expect(deliver(preparedPayload)).resolves.toEqual({ visibleReplySent: true });
    await expect(
      deliver(await prepare({ text: "⚠️ 🛠️ `search repos (agent)` failed" })),
    ).resolves.toEqual({ visibleReplySent: false });

    expect(mocks.send).toHaveBeenCalledExactlyOnceWith(
      "room-1",
      "Done.\n\nAttachment: https://example.com/a.png",
      { cfg: defaultConfig, accountId: "default", replyTo: "reply-1" },
    );
  });
});
