import assert from "node:assert/strict";
import { ChannelType } from "discord-api-types/v10";
import type { ChannelMessageActionName } from "openclaw/plugin-sdk/channel-contract";
import { createStartAccountContext } from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createTestPluginServiceScheduler } from "openclaw/plugin-sdk/plugin-test-api";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedDiscordAccount } from "./accounts.js";
import * as discordClient from "./client.js";
import * as directoryLive from "./directory-live.js";
import { RequestClient } from "./internal/rest.js";
import { createDiscordLivePolicyReader } from "./monitor/live-policy.js";
import type { MonitorDiscordOpts } from "./monitor/provider.js";
import * as sendModule from "./send.js";
import { argAt, objectArgAt, recordField } from "./test-support/mock-calls.js";
let discordPlugin: typeof import("./channel.js").discordPlugin;
let setDiscordRuntime: typeof import("./runtime.js").setDiscordRuntime;

const probeDiscordMock = vi.hoisted(() => vi.fn());
const monitorDiscordProviderMock = vi.hoisted(() => vi.fn());
const sleepWithAbortMock = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("openclaw/plugin-sdk/runtime-env", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/runtime-env")>(
    "openclaw/plugin-sdk/runtime-env",
  );
  return { ...actual, sleepWithAbort: sleepWithAbortMock };
});

// mock-isolation: Probe outcomes are synthetic; never contact Discord from channel tests.
vi.mock("./probe.js", () => ({ probeDiscord: probeDiscordMock }));
// mock-isolation: Startup assertions must not launch a live Discord monitor.
vi.mock("./monitor/provider.runtime.js", () => ({
  monitorDiscordProvider: monitorDiscordProviderMock,
}));

type DiscordConfig = NonNullable<OpenClawConfig["channels"]>["discord"];
function createCfg(
  discord: DiscordConfig = { enabled: true, token: "discord-token" },
): OpenClawConfig {
  return { channels: { discord } };
}

type TargetOptions = Parameters<
  NonNullable<
    NonNullable<NonNullable<typeof discordPlugin.messaging>["targetResolver"]>["resolveTarget"]
  >
>[0];
function resolveTarget(input: string, normalized: string, options: Partial<TargetOptions> = {}) {
  const resolve = discordPlugin.messaging?.targetResolver?.resolveTarget;
  assert(resolve, "Expected Discord target resolver");
  return resolve({ cfg: createCfg(), accountId: "default", input, normalized, ...options });
}

function resolveAccount(cfg: OpenClawConfig, accountId = "default"): ResolvedDiscordAccount {
  return discordPlugin.config.resolveAccount(cfg, accountId);
}

function accountContext(
  cfg: OpenClawConfig,
  accountId = "default",
  statusPatchSink?: Parameters<typeof createStartAccountContext>[0]["statusPatchSink"],
) {
  return {
    ...createStartAccountContext({ account: resolveAccount(cfg, accountId), cfg, statusPatchSink }),
    scheduler: createTestPluginServiceScheduler(),
  };
}

function startDiscordAccount(cfg: OpenClawConfig, accountId = "default") {
  return discordPlugin.gateway!.startAccount!(accountContext(cfg, accountId));
}

const probeResult = (username: string) => ({
  ok: true as const,
  bot: { username },
  application: {
    intents: {
      messageContent: "limited" as const,
      guildMembers: "disabled" as const,
      presence: "disabled" as const,
    },
  },
  elapsedMs: 1,
});

function prepareDiscordStartupMocks() {
  probeDiscordMock.mockResolvedValue(probeResult("Jarvis"));
  monitorDiscordProviderMock.mockResolvedValue(undefined);
}

async function expectDiscordStartupDelay(
  cfg: OpenClawConfig,
  accountId: string,
  expectedMs: number,
) {
  const ctx = accountContext(cfg, accountId);
  sleepWithAbortMock.mockClear();
  await discordPlugin.gateway!.startAccount!(ctx);
  if (expectedMs === 0) {
    expect(sleepWithAbortMock).not.toHaveBeenCalled();
    return;
  }
  expect(sleepWithAbortMock).toHaveBeenCalledOnce();
  expect(sleepWithAbortMock).toHaveBeenCalledWith(expectedMs, ctx.abortSignal);
}

const commandDeployStore = () => ({
  lookup: vi.fn(async () => undefined),
  register: vi.fn(async () => undefined),
});

function installDiscordRuntime(
  openKeyedStore: (options: Record<string, unknown>) => unknown = vi.fn(commandDeployStore),
) {
  setDiscordRuntime({
    logging: { shouldLogVerbose: () => false },
    state: { openKeyedStore },
  } as unknown as PluginRuntime);
}

function probeMetadata(statusPatches: Array<Record<string, unknown>>) {
  return statusPatches
    .filter((patch) => "bot" in patch && "application" in patch)
    .map(({ bot, application }) => ({ bot, application }));
}

function startupContext(stale = false) {
  const cfg = createCfg();
  const statusPatches: Array<Record<string, unknown>> = [];
  const ctx = accountContext(cfg, "default", (next) => statusPatches.push({ ...next }));
  if (stale) {
    ctx.setStatus({
      accountId: "default",
      bot: { username: "OldBot" },
      application: { intents: { messageContent: "enabled" } },
    });
  }
  return { ctx, statusPatches };
}

async function diagnosePermissions(channelId: string, timeoutMs = 5000) {
  const cfg = createCfg();
  return await discordPlugin.status!.buildCapabilitiesDiagnostics!({
    account: resolveAccount(cfg),
    cfg,
    timeoutMs,
    target: `channel:${channelId}`,
  });
}

function mockPermissions(channelId: string, channelType: ChannelType) {
  return vi.spyOn(sendModule, "fetchChannelPermissionsDiscord").mockResolvedValueOnce({
    channelId,
    channelType,
    guildId: "123",
    permissions: ["ViewChannel", "SendMessages"],
    raw: "0",
    isDm: false,
  });
}

afterEach(() => {
  probeDiscordMock.mockReset();
  monitorDiscordProviderMock.mockReset();
  sleepWithAbortMock.mockReset();
  sleepWithAbortMock.mockResolvedValue(undefined);
});

beforeEach(async () => {
  vi.useRealTimers();
  installDiscordRuntime();
});

beforeAll(async () => {
  ({ discordPlugin } = await import("./channel.js"));
  ({ setDiscordRuntime } = await import("./runtime.js"));
});

const guildPolicyCases: Array<{
  name: string;
  accountId: string;
  warning: boolean;
  discord: NonNullable<DiscordConfig>;
}> = [
  {
    name: "named account override",
    accountId: "ops",
    warning: true,
    discord: {
      groupPolicy: "open",
      accounts: {
        ops: { token: "discord-token", groupPolicy: "allowlist", guilds: {} },
      },
    },
  },
  {
    name: "explicit default account overrides top-level guilds",
    accountId: "default",
    warning: true,
    discord: {
      token: "discord-token",
      groupPolicy: "allowlist",
      guilds: { "*": {} },
      accounts: { default: { guilds: {} } },
    },
  },
  {
    name: "disabled account",
    accountId: "default",
    warning: false,
    discord: { token: "discord-token", groupPolicy: "allowlist", enabled: false },
  },
];
it.each(guildPolicyCases)(
  "discordPlugin reports effective guild policy for $name without probing",
  async ({ discord, accountId, warning }) => {
    const cfg = createCfg(discord);
    const account = resolveAccount(cfg, accountId);
    const snapshot = await discordPlugin.status!.buildAccountSnapshot!({
      account,
      cfg,
      runtime: { accountId, running: true, connected: true, lastError: null },
    });
    const issues = discordPlugin.status!.collectStatusIssues!([snapshot]);
    expect(
      issues.some((issue) => issue.kind === "config" && issue.message.includes("no guilds")),
    ).toBe(warning);
    expect(snapshot).toMatchObject({ running: account.enabled, lastError: null });
    if (account.enabled) {
      expect(snapshot.connected).toBe(true);
    }
    if (warning && accountId === "default") {
      expect(issues[0]?.fix).toContain("channels.discord.accounts.default.guilds");
    }
    expect(probeDiscordMock).not.toHaveBeenCalled();
  },
);

it.each([
  [
    " channel:1510164477642014999 ",
    { conversationId: "channel:1510164477642014999", matchPriority: 1 },
  ],
  ["1510164477642014740", { conversationId: "1510164477642014740", matchPriority: 2 }],
  ["channel:other", null],
] as const)("discordPlugin matches configured binding %s", (configuredId, expected) => {
  const provider = discordPlugin.bindings;
  assert(provider);
  const binding: NonNullable<OpenClawConfig["bindings"]>[number] = {
    type: "acp",
    agentId: "main",
    match: { channel: "discord", peer: { kind: "channel", id: configuredId } },
  };
  const compiledBinding = provider.compileConfiguredBinding({
    binding,
    conversationId: configuredId,
  });
  assert(compiledBinding);
  expect(compiledBinding.conversationId).toBe(configuredId.trim());
  expect(
    provider.matchInboundConversation({
      binding,
      compiledBinding,
      conversationId: "1510164477642014740",
      parentConversationId: "channel:1510164477642014999",
    }),
  ).toEqual(expected);
  expect(provider.compileConfiguredBinding({ binding, conversationId: "  " })).toBeNull();
});

it.each([
  [
    " original message ",
    [
      { type: "text", text: " original message " },
      { type: "divider" },
      { type: "context", text: "From Origin" },
    ],
  ],
  ["  ", [{ type: "context", text: "From Origin" }]],
] as const)("discordPlugin presents cross-context text '%s'", (message, blocks) => {
  const present = discordPlugin.messaging?.buildCrossContextPresentation;
  assert(present);
  expect(present({ cfg: {}, originLabel: "Origin", message })).toEqual({ tone: "neutral", blocks });
});

describe("discordPlugin outbound", () => {
  it("builds tool context with separate native and routable DM targets", () => {
    const buildToolContext = discordPlugin.threading?.buildToolContext;
    assert(buildToolContext);
    const hasRepliedRef = { value: false };

    expect(
      buildToolContext({
        cfg: {},
        context: {
          To: "user:123456789",
          NativeChannelId: "987654321",
          ChatType: "direct",
          CurrentMessageId: "message-1",
        },
        hasRepliedRef,
      }),
    ).toEqual({
      currentChannelId: "channel:987654321",
      currentChatType: "direct",
      currentMessagingTarget: "user:123456789",
      currentMessageId: "message-1",
      hasRepliedRef,
    });
  });

  it("resolves the current thread only for sends addressed to that thread's channel", () => {
    const resolveAutoThreadId = discordPlugin.threading?.resolveAutoThreadId;
    assert(resolveAutoThreadId);
    const resolveFor = (to: string, currentThreadTs?: string) =>
      resolveAutoThreadId({
        cfg: {},
        to,
        toolContext: { currentChannelId: "channel:111", currentThreadTs },
      });

    expect(resolveFor("channel:111", "111")).toBe("111");
    expect(resolveFor("111", "111")).toBe("111");
    expect(resolveFor("channel:222", "111")).toBeUndefined();
    expect(resolveFor("user:111", "111")).toBeUndefined();
    expect(resolveFor("channel:111")).toBeUndefined();
  });

  it("routes Discord message actions through the gateway", () => {
    const mode = (action: ChannelMessageActionName) =>
      discordPlugin.actions?.resolveExecutionMode?.({ action });
    expect(
      (
        ["read", "search", "send", "upload-file", "thread-reply", "poll", "channel-info"] as const
      ).map(mode),
    ).toEqual(["gateway", "gateway", "local", "local", "local", "local", "gateway"]);
    expect(discordPlugin.actions?.supportsAction?.({ action: "poll" })).toBe(false);
  });

  it("adds Discord mention formatting to agent prompt hints", () => {
    const hints = discordPlugin.agentPrompt?.messageToolHints?.({} as never) ?? [];

    expect(hints).toContain(
      "- Discord mentions: use supported mention syntax: users `<@USER_ID>`, channels `<#CHANNEL_ID>`, and roles `<@&ROLE_ID>`. Plain `@name` text only pings when a configured `mentionAliases` entry rewrites it; do not use the legacy `<@!USER_ID>` nickname form.",
    );
  });

  it.each([
    ["user:123", "user:123", "direct"],
    ["<@!456>", "user:456", "direct"],
    ["channel:789", "channel:789", "channel"],
    ["1470130713209602050", "channel:1470130713209602050", "channel"],
  ])("preserves target %s for delivery routing", (to, normalized, chatType) => {
    const messaging = discordPlugin.messaging;
    assert(messaging?.normalizeTarget && messaging.inferTargetChatType);
    expect(messaging.normalizeTarget(to)).toBe(normalized);
    expect(messaging.inferTargetChatType({ to })).toBe(chatType);
  });

  it("preserves the normalized channel kind for bare current-channel ids", async () => {
    await expect(
      resolveTarget("1470130713209602050", "channel:1470130713209602050"),
    ).resolves.toEqual({
      to: "channel:1470130713209602050",
      kind: "channel",
      display: "1470130713209602050",
      source: "normalized",
    });
  });

  it("keeps allowlisted bare Discord ids routable as DMs", async () => {
    await expect(
      resolveTarget("123456789", "channel:123456789", {
        cfg: createCfg({
          accounts: { default: { token: "discord-token", allowFrom: ["123456789"] } },
        }),
      }),
    ).resolves.toEqual({
      to: "user:123456789",
      kind: "user",
      display: "123456789",
      source: "directory",
    });
  });

  it("honors per-account replyToMode overrides", () => {
    const resolveReplyToMode = discordPlugin.threading?.resolveReplyToMode;
    assert(resolveReplyToMode);
    const cfg = createCfg({
      replyToMode: "all",
      token: "discord-token",
      accounts: { work: { token: "discord-token-work", replyToMode: "first" } },
    });

    expect(resolveReplyToMode({ cfg, accountId: "work" })).toBe("first");
    expect(resolveReplyToMode({ cfg, accountId: "default" })).toBe("all");
  });

  it("sends typing to the attached Discord thread", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status: 204 }));
    const rest = new RequestClient("synthetic-token", { fetch });
    const resolveRest = vi.spyOn(discordClient, "resolveDiscordRest").mockReturnValue(rest);
    try {
      await discordPlugin.heartbeat!.sendTyping!({
        cfg: createCfg(),
        to: "channel:123",
        accountId: "work",
        threadId: "456",
      });
      expect(fetch).toHaveBeenCalledOnce();
      expect(fetch.mock.calls[0]?.[0]).toBe("https://discord.com/api/v10/channels/456/typing");
      expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: "POST" });
    } finally {
      resolveRest.mockRestore();
    }
  });

  it.each(["cancelled", "revoked"] as const)(
    "does not send queued typing after its owner is %s",
    async (reason) => {
      const releaseWorkers = createDeferred<void>();
      const typingQueued = createDeferred<void>();
      const fetch = vi.fn<typeof globalThis.fetch>(async () => {
        await releaseWorkers.promise;
        return new Response(null, { status: 204 });
      });
      const rest = new RequestClient("synthetic-token", { fetch });
      const post = rest.post.bind(rest);
      vi.spyOn(rest, "post").mockImplementation((...args) => {
        const pending = post(...args);
        typingQueued.resolve();
        return pending;
      });
      const resolveRest = vi.spyOn(discordClient, "resolveDiscordRest").mockReturnValue(rest);
      const active = Array.from({ length: 4 }, (_, index) =>
        rest.get(`/channels/blocked-${index}/messages`),
      );
      const controller = new AbortController();
      let current = true;
      const queued = discordPlugin.heartbeat!.sendTypingGuarded!({
        cfg: createCfg(),
        to: "channel:123",
        signal: controller.signal,
        assertPlatformSendAuthorized: () => {
          if (!current) {
            throw new Error("typing owner revoked");
          }
        },
      });
      const rejected = expect(queued).rejects.toThrow();
      try {
        await typingQueued.promise;
        if (reason === "cancelled") {
          controller.abort();
        } else {
          current = false;
        }
        releaseWorkers.resolve();
        await Promise.all(active);
        await rejected;
        expect(fetch).toHaveBeenCalledTimes(4);
      } finally {
        releaseWorkers.resolve();
        await Promise.allSettled([...active, queued]);
        resolveRest.mockRestore();
      }
    },
  );

  it("subtracts lazy probe loading from the status budget", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValueOnce(1_000).mockReturnValueOnce(1_200);
    probeDiscordMock.mockResolvedValue({ ok: true, elapsedMs: 1 });
    try {
      const cfg = createCfg();
      await discordPlugin.status!.probeAccount!({
        account: resolveAccount(cfg),
        timeoutMs: 5_000,
        cfg,
      });

      expect(probeDiscordMock).toHaveBeenCalledWith("discord-token", 4_800, {
        includeApplication: true,
      });
    } finally {
      nowSpy.mockRestore();
    }
  });

  it.each([
    ["222", ChannelType.GuildVoice, ["Connect", "Speak", "ReadMessageHistory"]],
    ["333", ChannelType.GuildPublicThread, ["SendMessagesInThreads"]],
  ] as const)("reports required permissions for channel %s", async (id, type, missingRequired) => {
    const fetchPermissionsSpy = mockPermissions(id, type);
    try {
      const diagnostics = await diagnosePermissions(id);
      expect(argAt(fetchPermissionsSpy, 0, 0)).toBe(id);
      expect(objectArgAt(fetchPermissionsSpy, 0, 1).token).toBe("discord-token");
      expect(recordField(diagnostics?.details?.permissions, "permissions")).toMatchObject({
        channelId: id,
        missingRequired,
      });
      expect(diagnostics?.lines?.map((line) => line.text).join("\n")).toContain(
        `Missing required: ${missingRequired.join(", ")}`,
      );
    } finally {
      fetchPermissionsSpy.mockRestore();
    }
  });

  it("returns a timeout error when capabilities diagnostics exceed the timeout", async () => {
    let diagnosticSignal: AbortSignal | undefined;
    const fetchPermissionsSpy = vi
      .spyOn(sendModule, "fetchChannelPermissionsDiscord")
      .mockImplementation(
        async (_channelId, opts) =>
          await new Promise<never>((_, reject) => {
            diagnosticSignal = opts.signal;
            opts.signal?.addEventListener(
              "abort",
              () => reject(new Error("permission lookup aborted")),
              { once: true },
            );
          }),
      );
    try {
      const diagnostics = await diagnosePermissions("222", 10);

      const timeoutPerms = recordField(diagnostics?.details?.permissions, "permissions");
      expect(String(timeoutPerms.error)).toContain("timed out");
      expect(diagnostics?.lines?.[0]?.tone).toBe("error");
      expect(objectArgAt(fetchPermissionsSpy, 0, 1).timeoutMs).toBe(10);
      expect(diagnosticSignal?.aborted).toBe(true);
    } finally {
      fetchPermissionsSpy.mockRestore();
    }
  });

  it("fails loudly before provider startup when a token SecretRef is configured but unresolved", async () => {
    const cfg = createCfg({
      token: { source: "env", provider: "default", id: "DISCORD_BOT_TOKEN" },
    });

    await expect(startDiscordAccount(cfg)).rejects.toThrow(
      'Discord bot token configured for account "default" is unavailable',
    );
    expect(probeDiscordMock).not.toHaveBeenCalled();
    expect(monitorDiscordProviderMock).not.toHaveBeenCalled();
  });

  it("does not block Discord monitor startup on the startup probe", async () => {
    const commandDeployHashStore = commandDeployStore();
    const openKeyedStore = vi.fn(() => commandDeployHashStore);
    installDiscordRuntime(openKeyedStore);
    const probe = createDeferred<ReturnType<typeof probeResult>>();
    probeDiscordMock.mockReturnValue(probe.promise);
    monitorDiscordProviderMock.mockResolvedValue(undefined);

    const { ctx, statusPatches } = startupContext();
    await discordPlugin.gateway!.startAccount!(ctx);

    const monitorParams = objectArgAt(monitorDiscordProviderMock, 0, 0);
    expect(monitorParams).toMatchObject({ token: "discord-token", accountId: "default" });
    expect(sleepWithAbortMock).not.toHaveBeenCalled();
    expect(openKeyedStore).toHaveBeenCalledWith({
      namespace: "command-deploy-hashes",
      maxEntries: 10_000,
      overflowPolicy: "evict-oldest",
    });
    expect(monitorParams.commandDeployHashStore).toBe(commandDeployHashStore);
    await vi.waitFor(() =>
      expect(probeDiscordMock).toHaveBeenCalledWith("discord-token", 2500, {
        includeApplication: true,
      }),
    );
    expect(statusPatches.filter((patch) => "bot" in patch || "application" in patch)).toEqual([]);

    const { bot, application } = probeResult("AsyncBob");
    probe.resolve(probeResult("AsyncBob"));

    await vi.waitFor(() => expect(probeMetadata(statusPatches)).toEqual([{ bot, application }]));
  });

  it("continues Discord startup when the command deployment cache cannot open", async () => {
    prepareDiscordStartupMocks();
    installDiscordRuntime(() => {
      throw new Error("SQLite unavailable");
    });

    await startDiscordAccount(createCfg());

    expect(objectArgAt(monitorDiscordProviderMock, 0, 0).commandDeployHashStore).toBeUndefined();
  });

  it.each(["degrades", "throws"])("clears stale metadata when the probe %s", async (outcome) => {
    if (outcome === "throws") {
      probeDiscordMock.mockRejectedValue(new Error("probe timed out"));
    } else {
      probeDiscordMock.mockResolvedValue({
        ok: false,
        status: 401,
        error: "getMe failed (401)",
        elapsedMs: 1,
      });
    }
    monitorDiscordProviderMock.mockResolvedValue(undefined);
    const { ctx, statusPatches } = startupContext(true);
    await discordPlugin.gateway!.startAccount!(ctx);
    await vi.waitFor(() =>
      expect(
        probeMetadata(statusPatches).filter(
          ({ bot, application }) => bot === undefined && application === undefined,
        ),
      ).toEqual([{ bot: undefined, application: undefined }]),
    );
  });

  it("follows live policy published during a staggered account start", async () => {
    prepareDiscordStartupMocks();
    const cfg = createCfg({
      accounts: {
        alpha: { token: "alpha-token" },
        zeta: { token: "zeta-token", allowFrom: ["111"] },
      },
    });
    const ready = createDeferred<undefined>();
    sleepWithAbortMock.mockReturnValueOnce(ready.promise);
    let readPolicy: ReturnType<typeof createDiscordLivePolicyReader> | undefined;
    monitorDiscordProviderMock.mockImplementationOnce((opts: MonitorDiscordOpts) => {
      readPolicy = createDiscordLivePolicyReader({
        cfg: opts.config!,
        accountId: opts.accountId!,
        readConfig: opts.readConfig,
      });
    });
    setRuntimeConfigSnapshot(cfg, cfg);
    try {
      const pending = startDiscordAccount(cfg, "zeta");
      await vi.waitFor(() => expect(sleepWithAbortMock).toHaveBeenCalled());
      const next = createCfg({
        ...cfg.channels?.discord,
        accounts: {
          ...cfg.channels?.discord?.accounts,
          zeta: { token: "zeta-token", allowFrom: ["222"] },
        },
      });
      setRuntimeConfigSnapshot(next, next);
      ready.resolve(undefined);
      await pending;
      expect((await readPolicy!()).allowFrom).toEqual(["222"]);
      setRuntimeConfigSnapshot(cfg, cfg);
      expect((await readPolicy!()).allowFrom).toEqual(["111"]);
    } finally {
      ready.resolve(undefined);
      clearRuntimeConfigSnapshot();
    }
  });

  const startupSlotCases: Array<{
    name: string;
    defaultAccount: string | undefined;
    accounts: NonNullable<NonNullable<DiscordConfig>["accounts"]>;
    slots: string[];
  }> = [
    {
      name: "configured default first",
      defaultAccount: "main",
      accounts: {
        billy: { token: "Bot billy-token", enabled: true },
        farber: { token: "Bot farber-token", enabled: true },
        main: { token: "Bot main-token", enabled: true },
      },
      slots: ["main", "billy", "farber"],
    },
    {
      name: "duplicate-token default excluded",
      defaultAccount: "main",
      accounts: {
        billy: { token: "Bot billy-token", enabled: true },
        farber: { token: "Bot shared-token", enabled: true },
        main: { token: "Bot shared-token", enabled: true },
      },
      slots: ["billy", "farber"],
    },
    {
      name: "unconfigured accounts excluded",
      defaultAccount: undefined,
      accounts: { alpha: { enabled: true }, zeta: { token: "Bot zeta-token", enabled: true } },
      slots: ["zeta"],
    },
  ];
  it.each(startupSlotCases)(
    "assigns startup slots with $name",
    async ({ defaultAccount, accounts, slots }) => {
      prepareDiscordStartupMocks();
      const cfg = createCfg({ defaultAccount, accounts });
      for (const [index, accountId] of slots.entries()) {
        await expectDiscordStartupDelay(cfg, accountId, index * 10_000);
      }
    },
  );
});

it.each([
  [
    "direct sender context",
    {
      chatType: "direct",
      from: "discord:123456789012345678",
      originatingTo: "channel:dm-channel-1",
      fallbackTo: "channel:dm-channel-1",
    },
    { conversationId: "user:123456789012345678" },
  ],
  [
    "user-prefixed DM",
    { originatingTo: "user:123456789012345678" },
    { conversationId: "user:123456789012345678" },
  ],
  [
    "channel-prefixed thread parent",
    {
      originatingTo: "channel:thread-42",
      threadId: "thread-42",
      threadParentId: "parent-9",
    },
    { conversationId: "thread-42", parentConversationId: "channel:parent-9" },
  ],
] as const)("discordPlugin resolves binding conversation from %s", (_, context, expected) => {
  expect(
    discordPlugin.bindings?.resolveCommandConversation?.({
      accountId: "default",
      ...context,
    }),
  ).toEqual(expected);
});

it("discordPlugin normalizes dm allowlist entries with trimmed prefixes and mentions", () => {
  const resolveDmPolicy = discordPlugin.security?.resolveDmPolicy;
  assert(resolveDmPolicy);
  const cfg = createCfg({
    token: "discord-token",
    dmPolicy: "allowlist",
    allowFrom: ["  discord:<@!123456789>  "],
  });

  const result = resolveDmPolicy({
    cfg,
    account: discordPlugin.config.resolveAccount(cfg, "default"),
  });
  assert(result);
  expect(result).toMatchObject({
    policy: "allowlist",
    allowFrom: ["  discord:<@!123456789>  "],
    policyPath: "channels.discord.dmPolicy",
    allowFromPath: "channels.discord.",
  });
  expect(result.normalizeEntry?.("  discord:<@!123456789>  ")).toBe("123456789");
  expect(result.normalizeEntry?.("  user:987654321  ")).toBe("987654321");
});

describe("discordPlugin groups", () => {
  it("uses plugin-owned group policy resolvers", () => {
    const cfg = {
      channels: {
        discord: {
          token: "discord-test",
          guilds: {
            guild1: {
              requireMention: false,
              tools: { allow: ["message.guild"] },
              channels: {
                "123": {
                  requireMention: true,
                  tools: { allow: ["message.channel"] },
                },
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(
      discordPlugin.groups?.resolveRequireMention?.({
        cfg,
        groupSpace: "guild1",
        groupId: "123",
      }),
    ).toBe(true);
    expect(
      discordPlugin.groups?.resolveToolPolicy?.({
        cfg,
        groupSpace: "guild1",
        groupId: "123",
      }),
    ).toEqual({ allow: ["message.channel"] });
  });
});

describe("discordPlugin messaging target resolver", () => {
  it("resolves Discord usernames through the messaging target resolver", async () => {
    vi.spyOn(directoryLive, "listDiscordDirectoryPeersLive").mockResolvedValueOnce([
      { kind: "user", id: "user:999", name: "Jane" } as const,
    ]);

    await expect(resolveTarget("jane", "channel:jane", { preferredKind: "user" })).resolves.toEqual(
      {
        to: "user:999",
        kind: "user",
        display: "jane",
        source: "directory",
      },
    );
  });

  it("rejects unresolved Discord names after the shared directory lookup misses", async () => {
    vi.spyOn(directoryLive, "listDiscordDirectoryPeersLive").mockResolvedValue([]);

    await expect(
      resolveTarget("channel:missing", "channel:missing", { preferredKind: "channel" }),
    ).resolves.toBeNull();
    await expect(
      resolveTarget("user:missing", "user:missing", { preferredKind: "user" }),
    ).resolves.toBeNull();
  });

  it("does not reinterpret a bare channel name as a Discord username on fallback", async () => {
    vi.spyOn(directoryLive, "listDiscordDirectoryPeersLive").mockResolvedValueOnce([
      { kind: "user", id: "user:999", name: "General" } as const,
    ]);

    await expect(resolveTarget("general", "channel:general")).resolves.toBeNull();
  });
});
