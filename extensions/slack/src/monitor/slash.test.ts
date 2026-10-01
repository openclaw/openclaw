import path from "node:path";
import { WebClient } from "@slack/web-api";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { setRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import {
  normalizeSessionDeliveryState,
  upsertSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createArgMenusHarness,
  createSlashCommand,
  firstDispatchArg,
  registerCommands,
} from "./slash.commands.test-harness.js";
import { firstMockArg, getSlackSlashMocks } from "./slash.test-harness.js";

const { dispatchMock } = getSlackSlashMocks();

function responseTexts(mock: ReturnType<typeof vi.fn>): unknown[] {
  return mock.mock.calls.map(([payload]) =>
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as { text?: unknown }).text
      : undefined,
  );
}

function createPolicyHarness(overrides?: {
  groupPolicy?: "open" | "allowlist";
  channelsConfig?: Record<string, { enabled?: boolean; requireMention?: boolean }>;
  channelId?: string;
  channelName?: string;
  allowFrom?: string[];
  useAccessGroups?: boolean;
  slashEphemeral?: boolean;
  slashCommandEnabled?: boolean;
  slashCommandName?: string;
  teamId?: string;
  installationIdentity?:
    | { kind: "workspace"; teamId: string }
    | { kind: "enterprise"; enterpriseId: string };
  shouldDropMismatchedSlackEvent?: (body: unknown) => boolean;
  resolveChannelName?: () => Promise<{ name?: string; type?: string }>;
}) {
  const commands = new Map<unknown, (args: unknown) => Promise<void>>();
  const postMessage = vi.fn().mockResolvedValue({ ok: true, ts: "123.456" });
  const postEphemeral = vi.fn().mockResolvedValue({ ok: true });
  const listenerClient = { chat: { postMessage, postEphemeral } };
  const runtimeError = vi.fn();
  const installationIdentity = overrides?.installationIdentity ?? {
    kind: "workspace" as const,
    teamId: overrides?.teamId ?? "T1",
  };
  const boltContext =
    installationIdentity.kind === "enterprise"
      ? {
          teamId: overrides?.teamId,
          enterpriseId: installationIdentity.enterpriseId,
          isEnterpriseInstall: true,
        }
      : { teamId: installationIdentity.teamId, isEnterpriseInstall: false };
  const app = {
    client: listenerClient,
    command: (name: unknown, handler: (args: unknown) => Promise<void>) => {
      commands.set(name, async (args) => {
        const typed = args as { context?: Record<string, unknown>; client?: unknown };
        await handler({
          ...typed,
          context: { ...boltContext, ...typed.context },
          client: typed.client ?? listenerClient,
        });
      });
    },
  };

  const channelId = overrides?.channelId ?? "C_UNLISTED";
  const channelName = overrides?.channelName ?? "unlisted";

  const ctx = {
    cfg: { commands: { native: false } },
    runtime: { error: runtimeError },
    botToken: "bot-token",
    botUserId: "bot",
    teamId: installationIdentity.kind === "enterprise" ? "" : installationIdentity.teamId,
    installationIdentity,
    allowFrom: overrides?.allowFrom ?? ["*"],
    dmEnabled: true,
    dmPolicy: "open",
    groupDmEnabled: false,
    groupDmChannels: [],
    defaultRequireMention: true,
    groupPolicy: overrides?.groupPolicy ?? "open",
    useAccessGroups: overrides?.useAccessGroups ?? true,
    channelsConfig: overrides?.channelsConfig,
    slashCommand: {
      enabled: overrides?.slashCommandEnabled ?? true,
      name: overrides?.slashCommandName ?? "openclaw",
      ephemeral: overrides?.slashEphemeral ?? true,
      sessionPrefix: "slack:slash",
    },
    textLimit: 4000,
    app,
    isChannelAllowed: () => true,
    shouldDropMismatchedSlackEvent: (body: unknown) =>
      overrides?.shouldDropMismatchedSlackEvent?.(body) ?? false,
    resolveChannelName:
      overrides?.resolveChannelName ?? (async () => ({ name: channelName, type: "channel" })),
    resolveUserName: async () => ({ name: "Ada" }),
  };

  Object.assign(ctx, { readRuntimeContext: async () => ctx, isRuntimePolicyCurrent: () => true });
  const account = { accountId: "acct", config: { commands: { native: false } } } as unknown;

  return {
    commands,
    ctx,
    account,
    postMessage,
    postEphemeral,
    runtimeError,
    channelId,
    channelName,
  };
}

async function runSlashHandler(params: {
  commands: Map<unknown, (args: unknown) => Promise<void>>;
  body?: unknown;
  respond?: ReturnType<typeof vi.fn>;
  command: Partial<{
    user_id: string;
    user_name: string;
    channel_id: string;
    channel_name: string;
    text: string;
    trigger_id: string;
  }> &
    Pick<{ channel_id: string; channel_name: string }, "channel_id" | "channel_name">;
}): Promise<{ respond: ReturnType<typeof vi.fn>; ack: ReturnType<typeof vi.fn> }> {
  const handler = [...params.commands.values()][0];
  if (!handler) {
    throw new Error("Missing slash handler");
  }

  const respond = params.respond ?? vi.fn().mockResolvedValue(undefined);
  const ack = vi.fn().mockResolvedValue(undefined);

  await handler({
    body: params.body,
    command: {
      user_id: "U1",
      user_name: "Ada",
      text: "hello",
      trigger_id: "t1",
      ...params.command,
    },
    ack,
    respond,
  });

  return { respond, ack };
}

async function registerAndRunPolicySlash(params: {
  harness: ReturnType<typeof createPolicyHarness>;
  body?: unknown;
  command?: Partial<{
    user_id: string;
    user_name: string;
    channel_id: string;
    channel_name: string;
    text: string;
    trigger_id: string;
  }>;
}) {
  await registerCommands(params.harness.ctx, params.harness.account);
  return await runSlashHandler({
    commands: params.harness.commands,
    body: params.body,
    command: {
      channel_id: params.command?.channel_id ?? params.harness.channelId,
      channel_name: params.command?.channel_name ?? params.harness.channelName,
      ...params.command,
    },
  });
}

function expectChannelBlockedResponse(respond: ReturnType<typeof vi.fn>) {
  expect(dispatchMock).not.toHaveBeenCalled();
  expect(respond).toHaveBeenCalledWith({
    text: "This channel is not allowed.",
    response_type: "ephemeral",
  });
}

function expectUnauthorizedResponse(respond: ReturnType<typeof vi.fn>) {
  expect(dispatchMock).not.toHaveBeenCalled();
  expect(respond).toHaveBeenCalledWith({
    text: "You are not authorized to use this command.",
    response_type: "ephemeral",
  });
}

describe("Slack App Home command presentation", () => {
  it("returns the configured single command when it is registered", async () => {
    const harness = createPolicyHarness({ slashCommandName: "acme" });

    await expect(registerCommands(harness.ctx, harness.account)).resolves.toEqual({
      mode: "single",
      name: "acme",
    });
    expect(harness.commands.size).toBe(1);
  });

  it("omits the single command when slash commands are disabled", async () => {
    const harness = createPolicyHarness({ slashCommandEnabled: false });

    await expect(registerCommands(harness.ctx, harness.account)).resolves.toEqual({
      mode: "disabled",
    });
    expect(harness.commands.size).toBe(0);
  });

  it("omits the single command when native commands take precedence", async () => {
    const harness = createArgMenusHarness();

    await expect(registerCommands(harness.ctx, harness.account)).resolves.toEqual({
      mode: "native",
    });
    expect(harness.commands.size).toBeGreaterThan(0);
  });
});

describe("slack slash commands channel policy", () => {
  it("drops mismatched slash payloads before dispatch", async () => {
    const harness = createPolicyHarness({
      shouldDropMismatchedSlackEvent: () => true,
    });
    const { respond, ack } = await registerAndRunPolicySlash({
      harness,
      body: {
        api_app_id: "A_MISMATCH",
        team_id: "T_MISMATCH",
      },
    });

    expect(ack).toHaveBeenCalledTimes(1);
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(respond).not.toHaveBeenCalled();
  });

  it.each<{
    name: string;
    policy: NonNullable<Parameters<typeof createPolicyHarness>[0]>;
    blocked: boolean;
  }>([
    {
      name: "allows unlisted channels when groupPolicy is open",
      policy: {
        groupPolicy: "open",
        channelsConfig: { C_LISTED: { requireMention: true } },
        channelId: "C_UNLISTED",
        channelName: "unlisted",
      },
      blocked: false,
    },
    {
      name: "blocks explicitly denied channels when groupPolicy is open",
      policy: {
        groupPolicy: "open",
        channelsConfig: { C_DENIED: { enabled: false } },
        channelId: "C_DENIED",
        channelName: "denied",
      },
      blocked: true,
    },
    {
      name: "blocks unlisted channels when groupPolicy is allowlist",
      policy: {
        groupPolicy: "allowlist",
        channelsConfig: { C_LISTED: { requireMention: true } },
        channelId: "C_UNLISTED",
        channelName: "unlisted",
      },
      blocked: true,
    },
  ])("$name", async ({ policy, blocked }) => {
    const harness = createPolicyHarness(policy);
    const { respond } = await registerAndRunPolicySlash({ harness });

    if (blocked) {
      expectChannelBlockedResponse(respond);
      return;
    }
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(responseTexts(respond)).not.toContain("This channel is not allowed.");
  });
});

describe("slack slash commands access groups", () => {
  it("fails closed when channel type lookup returns empty for channels", async () => {
    const harness = createPolicyHarness({
      allowFrom: [],
      channelId: "C_UNKNOWN",
      channelName: "unknown",
      resolveChannelName: async () => ({}),
    });
    const { respond } = await registerAndRunPolicySlash({ harness });

    expectUnauthorizedResponse(respond);
  });

  it("still treats D-prefixed channel ids as DMs when lookup fails", async () => {
    const harness = createPolicyHarness({
      allowFrom: ["*"],
      channelId: "D123",
      channelName: "notdirectmessage",
      resolveChannelName: async () => ({}),
    });
    const { respond } = await registerAndRunPolicySlash({
      harness,
      command: {
        channel_id: "D123",
        channel_name: "notdirectmessage",
      },
    });

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(responseTexts(respond)).not.toContain("You are not authorized to use this command.");
    const dispatchArg = firstDispatchArg() as {
      ctx?: { CommandAuthorized?: boolean };
    };
    expect(dispatchArg?.ctx?.CommandAuthorized).toBe(true);
  });

  it("computes CommandAuthorized for DM slash commands when dmPolicy is open", async () => {
    const harness = createPolicyHarness({
      allowFrom: ["*"],
      channelId: "D999",
      channelName: "directmessage",
      resolveChannelName: async () => ({ name: "directmessage", type: "im" }),
    });
    await registerAndRunPolicySlash({
      harness,
      command: {
        user_id: "U_ATTACKER",
        user_name: "Mallory",
        channel_id: "D999",
        channel_name: "directmessage",
      },
    });

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const dispatchArg = firstDispatchArg() as {
      ctx?: { CommandAuthorized?: boolean };
    };
    expect(dispatchArg?.ctx?.CommandAuthorized).toBe(true);
  });

  it.each([
    {
      name: "blocks MPIM slash commands from senders outside the configured allowFrom",
      userId: "U_ATTACKER",
      allowed: false,
    },
    {
      name: "allows MPIM slash commands from senders in the configured allowFrom",
      userId: "U_OWNER",
      allowed: true,
    },
  ])("$name", async ({ userId, allowed }) => {
    const harness = createPolicyHarness({
      allowFrom: ["U_OWNER"],
      channelId: "G_MPIM",
      channelName: "group-dm",
      resolveChannelName: async () => ({ name: "group-dm", type: "mpim" }),
      ...(!allowed ? { useAccessGroups: false } : {}),
    });
    const { respond } = await registerAndRunPolicySlash({
      harness,
      command: { user_id: userId },
    });

    if (!allowed) {
      expect(dispatchMock).not.toHaveBeenCalled();
      expect(respond).toHaveBeenCalledWith({
        text: "You are not authorized to use this command here.",
        response_type: "ephemeral",
      });
      return;
    }
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(responseTexts(respond)).not.toContain(
      "You are not authorized to use this command here.",
    );
    expect(firstDispatchArg().ctx).toMatchObject({
      ChatType: "group",
      From: "slack:group:G_MPIM",
    });
  });

  it("enforces access-group gating when lookup fails for private channels", async () => {
    const harness = createPolicyHarness({
      allowFrom: [],
      channelId: "G123",
      channelName: "private",
      resolveChannelName: async () => ({}),
    });
    const { respond } = await registerAndRunPolicySlash({ harness });

    expectUnauthorizedResponse(respond);
  });
});

describe("slack slash command session metadata", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  const { deliverSlackSlashRepliesMock, recordSessionMetaFromInboundMock, resolveAgentRouteMock } =
    getSlackSlashMocks();

  it("routes threaded native Stop to the ordinary DM parent after a policy reload", async () => {
    const { createInboundSlackTestContext, createSlackTestAccount } =
      await import("./message-handler/prepare.test-helpers.js");
    const { createSlackCommandHandler } = await import("./slash.js");
    const storePath = path.join(tempDirs.make("slack-threaded-stop-"), "sessions.sqlite");
    const cfg: OpenClawConfig = {
      session: { store: storePath },
      channels: { slack: { dmPolicy: "open", allowFrom: ["*"] } },
    };
    setRuntimeConfigSnapshot(cfg, cfg);
    const client = new WebClient("xoxb-synthetic");
    vi.spyOn(client.conversations, "replies").mockResolvedValue({ ok: true, messages: [] });
    const ctx = createInboundSlackTestContext({ cfg, appClient: client });
    ctx.resolveChannelName = async () => ({ name: "directmessage", type: "im" });
    ctx.resolveUserName = async () => ({ name: "Ada" });
    ctx.runtime.error = vi.fn();
    const handleCommand = createSlackCommandHandler({ ctx, account: createSlackTestAccount() });
    await upsertSessionEntry({
      agentId: "main",
      storePath,
      sessionKey: "agent:main:main",
      entry: {
        sessionId: "ordinary-dm",
        updatedAt: Date.now(),
        chatType: "direct",
        delivery: normalizeSessionDeliveryState({
          context: { channel: "slack", accountId: "default", to: "U1" },
        }),
      },
    });
    const reloaded: OpenClawConfig = {
      ...cfg,
      channels: { slack: { ...cfg.channels?.slack, textChunkLimit: 24 } },
    };
    setRuntimeConfigSnapshot(reloaded, reloaded);

    const admitted = await handleCommand({
      command: createSlashCommand({ channel_id: "D123" }),
      threadTs: "170.111",
      eventTs: "171.222",
      builtInCommand: "stop",
      prompt: "/stop",
      ack: vi.fn(),
      respond: vi.fn(),
    });

    expect(ctx.runtime.error).not.toHaveBeenCalled();
    expect(admitted).toBe(true);
    expect(dispatchMock).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        cfg: reloaded,
        ctx: expect.objectContaining({
          CommandBody: "/stop",
          CommandTargetSessionKey: "agent:main:main",
          MessageThreadId: "170.111",
        }),
      }),
    );
  });

  it("refreshes slash routing and access policy between invocations", async () => {
    const harness = createPolicyHarness({
      channelId: "D123",
      channelName: "directmessage",
      resolveChannelName: async () => ({ name: "directmessage", type: "im" }),
    });
    const { createInboundSlackTestContext } =
      await import("./message-handler/prepare.test-helpers.js");
    const sourceCfg: OpenClawConfig = {
      ...harness.ctx.cfg,
      channels: { slack: { dmPolicy: "open", allowFrom: ["*"] } },
    };
    setRuntimeConfigSnapshot(sourceCfg, sourceCfg);
    const ctx = createInboundSlackTestContext({ cfg: sourceCfg, accountId: "acct" });
    Object.assign(ctx.app, harness.ctx.app);
    ctx.resolveChannelName = async () => ({ name: "directmessage", type: "im" });
    ctx.resolveUserName = harness.ctx.resolveUserName;
    ctx.slashCommand = harness.ctx.slashCommand;
    const runtimeCfg = {
      ...sourceCfg,
      session: { dmScope: "per-channel-peer" },
    } as OpenClawConfig;
    resolveAgentRouteMock.mockImplementation((params: { cfg: OpenClawConfig }) => ({
      agentId: "main",
      accountId: "acct",
      sessionKey:
        params.cfg.session?.dmScope === "per-channel-peer"
          ? "agent:main:slack:direct:U1"
          : "agent:main:main",
    }));
    await registerCommands(ctx, harness.account);

    const run = () =>
      runSlashHandler({
        commands: harness.commands,
        command: { channel_id: harness.channelId, channel_name: harness.channelName },
      });
    await run();
    setRuntimeConfigSnapshot(runtimeCfg, runtimeCfg);
    await run();

    expect(dispatchMock.mock.calls.map(([turn]) => turn.ctx.CommandTargetSessionKey)).toEqual([
      "agent:main:main",
      "agent:main:slack:direct:U1",
    ]);
    const disabled: OpenClawConfig = {
      ...runtimeCfg,
      channels: { slack: { dmPolicy: "disabled" } },
    };
    setRuntimeConfigSnapshot(disabled, disabled);
    await run();
    expect(dispatchMock).toHaveBeenCalledTimes(2);
  });

  it("calls recordSessionMetaFromInbound after dispatching a slash command", async () => {
    const harness = createPolicyHarness({ groupPolicy: "open" });
    await registerAndRunPolicySlash({ harness });

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(recordSessionMetaFromInboundMock).toHaveBeenCalledTimes(1);
    const call = firstMockArg(recordSessionMetaFromInboundMock, 0, "session meta") as {
      sessionKey?: string;
      ctx?: { GroupSpace?: string; OriginatingChannel?: string };
    };
    expect(call.ctx?.OriginatingChannel).toBe("slack");
    expect(call.ctx?.GroupSpace).toBe("T1");
    expect(call.sessionKey).toBeTypeOf("string");
    expect(call.sessionKey).not.toBe("");
  });

  it("partitions Enterprise Grid slash sessions and replies by event team", async () => {
    const harness = createPolicyHarness({
      groupPolicy: "open",
      slashEphemeral: false,
      installationIdentity: { kind: "enterprise", enterpriseId: "EGRID" },
      teamId: "TGRID1",
      channelId: "CGRID1",
      channelName: "grid",
    });

    await registerAndRunPolicySlash({ harness });

    expect(resolveAgentRouteMock).toHaveBeenCalledWith(
      expect.objectContaining({
        teamId: "TGRID1",
        peer: { kind: "channel", id: "team:TGRID1:channel:CGRID1" },
      }),
    );
    expect(firstDispatchArg().ctx).toMatchObject({
      From: "slack:channel:team:TGRID1:channel:CGRID1",
      To: "slash:team:TGRID1:user:U1",
      GroupSpace: "TGRID1",
      OriginatingTo: "team:TGRID1:channel:CGRID1",
      SessionKey: expect.stringContaining("team:tgrid1:user:u1"),
    });
  });

  it("passes canonical hook correlation to slash reply delivery", async () => {
    dispatchMock.mockImplementation((params: unknown) => {
      const deliver = (
        params as {
          dispatcherOptions: {
            deliver: (payload: { text: string }, info: { kind: "final" }) => Promise<void>;
          };
        }
      ).dispatcherOptions.deliver;
      void deliver({ text: "final answer" }, { kind: "final" });
      void deliver({ text: "second answer" }, { kind: "final" });
      return { counts: { final: 2, tool: 0, block: 0 } };
    });
    const harness = createPolicyHarness({ groupPolicy: "open" });
    await registerAndRunPolicySlash({ harness });
    const dispatchArg = firstDispatchArg() as {
      ctx?: { OriginatingTo?: string; SessionKey?: string };
    };
    const responseBudget = (
      deliverSlackSlashRepliesMock.mock.calls.at(-1)?.[0] as
        | { responseBudget?: unknown }
        | undefined
    )?.responseBudget;

    expect(deliverSlackSlashRepliesMock).toHaveBeenCalledOnce();
    expect(deliverSlackSlashRepliesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [{ text: "final answer" }, { text: "second answer" }],
        messageSentHookTarget: dispatchArg.ctx?.OriginatingTo,
        sessionKeyForInternalHooks: dispatchArg.ctx?.SessionKey,
        accountId: "acct",
        isGroup: true,
        groupId: harness.channelId,
      }),
    );
    expect(responseBudget).toBeDefined();
  });

  it("targets the channel for public slash reply hooks", async () => {
    dispatchMock.mockImplementation((params: unknown) => {
      const deliver = (
        params as {
          dispatcherOptions: {
            deliver: (payload: { text: string }, info: { kind: "final" }) => Promise<void>;
          };
        }
      ).dispatcherOptions.deliver;
      void deliver({ text: "public answer" }, { kind: "final" });
      return { counts: { final: 1, tool: 0, block: 0 } };
    });
    const harness = createPolicyHarness({
      groupPolicy: "open",
      slashEphemeral: false,
    });
    await registerAndRunPolicySlash({ harness });

    expect(firstDispatchArg().ctx?.OriginatingTo).toBe(`channel:${harness.channelId}`);
    expect(deliverSlackSlashRepliesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        messageSentHookTarget: `channel:${harness.channelId}`,
        isGroup: true,
        groupId: harness.channelId,
      }),
    );
  });

  it("fails a public Web API fallback that returns no message timestamp", async () => {
    deliverSlackSlashRepliesMock.mockImplementation(async (params: unknown) => {
      const responseBudget = (
        params as {
          responseBudget: {
            respond: (payload: { text: string; response_type: "in_channel" }) => Promise<unknown>;
          };
        }
      ).responseBudget;
      await responseBudget.respond({ text: "public answer", response_type: "in_channel" });
    });
    const asyncDispatchMock = dispatchMock as unknown as {
      mockImplementation: (
        implementation: (params: unknown) => Promise<unknown>,
      ) => typeof dispatchMock;
    };
    asyncDispatchMock.mockImplementation(async (params: unknown) => {
      const deliver = (
        params as {
          dispatcherOptions: {
            deliver: (payload: { text: string }, info: { kind: "final" }) => Promise<void>;
          };
        }
      ).dispatcherOptions.deliver;
      await deliver({ text: "public answer" }, { kind: "final" });
      return { counts: { final: 1, tool: 0, block: 0 } };
    });
    const harness = createPolicyHarness({ groupPolicy: "open", slashEphemeral: false });
    harness.postMessage.mockResolvedValueOnce({ ok: true, channel: harness.channelId });
    const respondError = Object.assign(new Error("response URL expired"), {
      code: "slack_bolt_respond_error",
    });
    const respond = vi.fn().mockRejectedValue(respondError);
    await registerCommands(harness.ctx, harness.account);

    await runSlashHandler({
      commands: harness.commands,
      command: {
        channel_id: harness.channelId,
        channel_name: harness.channelName,
      },
      respond,
    });

    expect(harness.postMessage).toHaveBeenCalledOnce();
    expect(harness.runtimeError).toHaveBeenCalledWith(
      expect.stringContaining("Slack chat.postMessage returned no message timestamp"),
    );
  });

  it("starts routed session metadata recording before dispatch without blocking delivery", async () => {
    const recordStarted = createDeferred<void>();
    const deferred = createDeferred<void>();
    recordSessionMetaFromInboundMock.mockClear().mockImplementation(() => {
      recordStarted.resolve();
      return deferred.promise;
    });

    const harness = createPolicyHarness({ groupPolicy: "open" });
    await registerCommands(harness.ctx, harness.account);

    const runPromise = runSlashHandler({
      commands: harness.commands,
      command: {
        channel_id: harness.channelId,
        channel_name: harness.channelName,
      },
    });

    await recordStarted.promise;
    expect(recordSessionMetaFromInboundMock).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      expect(dispatchMock).toHaveBeenCalledTimes(1);
    });

    deferred.resolve();
    await runPromise;
  });
});
