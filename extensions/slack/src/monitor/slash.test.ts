import path from "node:path";
import { WebClient } from "@slack/web-api";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { setRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import {
  normalizeSessionDeliveryState,
  upsertSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import { useSessionStoreTempDirs } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  createArgMenusHarness,
  createSlashCommand,
  firstDispatchArg,
  registerCommands,
  setAsyncDispatchMock,
} from "./slash.commands.test-harness.js";
import { getSlackSlashMocks } from "./slash.test-harness.js";

const { dispatchMock } = getSlackSlashMocks();

function createPolicyHarness(
  overrides: Parameters<typeof createArgMenusHarness>[1] & {
    channelId?: string;
    channelName?: string;
    allowFrom?: string[];
    useAccessGroups?: boolean;
    channelAllowed?: boolean;
    slashEphemeral?: boolean;
    slashCommandEnabled?: boolean;
    shouldDropMismatchedSlackEvent?: (body: unknown) => boolean;
    resolveChannelName?: () => Promise<{ name?: string; type?: string }>;
  } = {},
) {
  const harness = createArgMenusHarness({ commands: { native: false } }, overrides);
  const postMessage = vi.fn().mockResolvedValue({ ok: true, ts: "123.456" });
  const runtimeError = vi.fn();
  const channelId = overrides.channelId ?? "C_UNLISTED";
  const channelName = overrides.channelName ?? "unlisted";
  Object.assign(harness.app.client.chat, { postMessage });
  const ctx = Object.assign(harness.ctx, {
    runtime: { error: runtimeError },
    allowFrom: overrides.allowFrom ?? ["*"],
    useAccessGroups: overrides.useAccessGroups ?? true,
    isChannelAllowed: vi.fn(() => overrides.channelAllowed ?? true),
    shouldDropMismatchedSlackEvent: (body: unknown) =>
      overrides.shouldDropMismatchedSlackEvent?.(body) ?? false,
    resolveChannelName:
      overrides.resolveChannelName ?? (async () => ({ name: channelName, type: "channel" })),
  });
  Object.assign(ctx.slashCommand, {
    enabled: overrides.slashCommandEnabled ?? true,
    ephemeral: overrides.slashEphemeral ?? true,
  });
  const account = { accountId: "acct", config: { commands: { native: false } } } as unknown;
  return { ...harness, ctx, account, postMessage, runtimeError, channelId, channelName };
}

async function runSlashHandler(
  harness: ReturnType<typeof createPolicyHarness>,
  params: {
    body?: unknown;
    respond?: ReturnType<typeof vi.fn>;
    command?: Partial<ReturnType<typeof createSlashCommand>>;
  } = {},
) {
  const handler = [...harness.commands.values()][0];
  if (!handler) {
    throw new Error("Missing slash handler");
  }

  const respond = params.respond ?? vi.fn().mockResolvedValue(undefined);
  const ack = vi.fn().mockResolvedValue(undefined);

  await handler({
    body: params.body,
    command: createSlashCommand({
      channel_id: harness.channelId,
      channel_name: harness.channelName,
      text: "hello",
      ...params.command,
    }),
    ack,
    respond,
  });

  return { respond, ack };
}

async function registerAndRunPolicySlash(
  harness: ReturnType<typeof createPolicyHarness>,
  params: Parameters<typeof runSlashHandler>[1] = {},
) {
  await registerCommands(harness.ctx, harness.account);
  return runSlashHandler(harness, params);
}

function expectBlockedResponse(respond: ReturnType<typeof vi.fn>, text: string) {
  expect(dispatchMock).not.toHaveBeenCalled();
  expect(respond).toHaveBeenCalledWith({ text, response_type: "ephemeral" });
}

async function dispatchPublicAnswer(params: unknown) {
  const { dispatcherOptions } = params as {
    dispatcherOptions: {
      deliver: (payload: { text: string }, info: { kind: "final" }) => Promise<void>;
    };
  };
  await dispatcherOptions.deliver({ text: "public answer" }, { kind: "final" });
  return { counts: { final: 1, tool: 0, block: 0 } };
}

describe("slack slash commands channel policy", () => {
  it("omits the single command when slash commands are disabled", async () => {
    const harness = createPolicyHarness({ slashCommandEnabled: false });
    await expect(registerCommands(harness.ctx, harness.account)).resolves.toEqual({
      mode: "disabled",
    });
    expect(harness.commands.size).toBe(0);
  });
  it("drops mismatched slash payloads before dispatch", async () => {
    const harness = createPolicyHarness({ shouldDropMismatchedSlackEvent: () => true });
    const { respond, ack } = await registerAndRunPolicySlash(harness, {
      body: {
        api_app_id: "A_MISMATCH",
        team_id: "T_MISMATCH",
      },
    });

    expect(ack).toHaveBeenCalledTimes(1);
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(respond).not.toHaveBeenCalled();
  });

  it("honors denied monitor channel admission", async () => {
    const harness = createPolicyHarness({ channelAllowed: false });
    const { respond } = await registerAndRunPolicySlash(harness);
    expect(harness.ctx.isChannelAllowed).toHaveBeenCalledWith({
      teamId: "T1",
      channelId: "C_UNLISTED",
      channelName: "unlisted",
      channelType: "channel",
    });
    expectBlockedResponse(respond, "This channel is not allowed.");
  });
});

describe("slack slash commands access groups", () => {
  it("still treats D-prefixed channel ids as DMs when lookup fails", async () => {
    const harness = createPolicyHarness({
      allowFrom: ["*"],
      channelId: "D123",
      channelName: "notdirectmessage",
      resolveChannelName: async () => ({}),
    });
    await registerAndRunPolicySlash(harness);
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(firstDispatchArg().ctx?.CommandAuthorized).toBe(true);
  });

  it.each([
    { userId: "U_ATTACKER", allowed: false },
    { userId: "U_OWNER", allowed: true },
  ])("authorizes MPIM sender $userId: $allowed", async ({ userId, allowed }) => {
    const harness = createPolicyHarness({
      allowFrom: ["U_OWNER"],
      channelId: "G_MPIM",
      channelName: "group-dm",
      resolveChannelName: async () => ({ name: "group-dm", type: "mpim" }),
      ...(!allowed ? { useAccessGroups: false } : {}),
    });
    const { respond } = await registerAndRunPolicySlash(harness, {
      command: { user_id: userId },
    });

    if (!allowed) {
      expectBlockedResponse(respond, "You are not authorized to use this command here.");
      return;
    }
    expect(dispatchMock).toHaveBeenCalledTimes(1);
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
    const { respond } = await registerAndRunPolicySlash(harness);
    expectBlockedResponse(respond, "You are not authorized to use this command.");
  });
});

describe("slack slash command session metadata", () => {
  const tempDirs = useSessionStoreTempDirs(afterAll, "slack-threaded-stop-");
  const { deliverSlackSlashRepliesMock, resolveAgentRouteMock } = getSlackSlashMocks();

  it("routes threaded native Stop to the ordinary DM parent after a policy reload", async () => {
    const { createInboundSlackTestContext, createSlackTestAccount } =
      await import("./message-handler/prepare.test-helpers.js");
    const { createSlackCommandHandler } = await import("./slash.js");
    const storePath = path.join(tempDirs.make(), "sessions.sqlite");
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
    const { createInboundSlackTestContext } =
      await import("./message-handler/prepare.test-helpers.js");
    const harness = createPolicyHarness({
      channelId: "D123",
      channelName: "directmessage",
      resolveChannelName: async () => ({ name: "directmessage", type: "im" }),
    });
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
    const run = () => runSlashHandler(harness);
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

  it("partitions Enterprise Grid slash sessions and replies by event team", async () => {
    setAsyncDispatchMock(dispatchPublicAnswer);
    const harness = createPolicyHarness({
      slashEphemeral: false,
      installationIdentity: { kind: "enterprise", enterpriseId: "EGRID" },
      teamId: "TGRID1",
      channelId: "CGRID1",
      channelName: "grid",
    });
    await registerAndRunPolicySlash(harness);
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
    expect(deliverSlackSlashRepliesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        messageSentHookTarget: "team:TGRID1:channel:CGRID1",
        isGroup: true,
        groupId: harness.channelId,
      }),
    );
  });

  it("fails a public Web API fallback that returns no message timestamp", async () => {
    deliverSlackSlashRepliesMock.mockImplementation(async (params: unknown) => {
      const { responseBudget } = params as {
        responseBudget: {
          respond: (payload: { text: string; response_type: "in_channel" }) => Promise<unknown>;
        };
      };
      await responseBudget.respond({ text: "public answer", response_type: "in_channel" });
    });
    setAsyncDispatchMock(dispatchPublicAnswer);
    const harness = createPolicyHarness({ slashEphemeral: false });
    harness.postMessage.mockResolvedValueOnce({ ok: true, channel: harness.channelId });
    const respondError = Object.assign(new Error("response URL expired"), {
      code: "slack_bolt_respond_error",
    });
    const respond = vi.fn().mockRejectedValue(respondError);
    await registerAndRunPolicySlash(harness, { respond });
    expect(firstDispatchArg().ctx?.OriginatingTo).toBe(`channel:${harness.channelId}`);
    expect(harness.postMessage).toHaveBeenCalledOnce();
    expect(harness.runtimeError).toHaveBeenCalledWith(
      expect.stringContaining("Slack chat.postMessage returned no message timestamp"),
    );
  });
});
