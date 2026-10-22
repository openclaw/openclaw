import { CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY } from "openclaw/plugin-sdk/approval-handler-adapter-runtime";
import type { ChannelRuntimeSurface } from "openclaw/plugin-sdk/channel-contract";
import { buildChannelInboundEventContext } from "openclaw/plugin-sdk/channel-inbound";
import type { OpenClawConfig, SlackAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  setRuntimeConfigSnapshot,
  clearRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  flush,
  getSlackClient,
  getSlackHandlerOrThrow,
  getSlackTestState,
  resetSlackTestState,
  runSlackHandlerWithDispatch,
  startSlackMonitor,
  stopSlackMonitor,
} from "../monitor.test-helpers.js";

const { monitorSlackProvider } = await import("./provider.js");
const { replyMock, sendMock, appStopMock, resolveSlackUserAllowlistMock } = getSlackTestState();

beforeEach(() => resetSlackTestState());
afterEach(() => clearRuntimeConfigSnapshot());

function userEvent(user: string, ts: string, channel: string, channel_type: "im" | "channel") {
  return { event: { type: "message", user, ts, text: "hello", channel, channel_type } };
}

function slackConfig(slack: SlackAccountConfig): OpenClawConfig {
  return { channels: { slack: { enabled: true, ...slack } } };
}

function approvalConfig(slack: SlackAccountConfig): OpenClawConfig {
  return slackConfig({ botToken: "xoxb-test", appToken: "xapp-test", ...slack });
}

async function withMonitor(
  run: (handler: Awaited<ReturnType<typeof getSlackHandlerOrThrow>>) => Promise<void>,
  options?: Parameters<typeof startSlackMonitor>[1],
) {
  const monitor = startSlackMonitor(monitorSlackProvider, options);
  try {
    await run(await getSlackHandlerOrThrow("message"));
  } finally {
    await stopSlackMonitor(monitor);
  }
}

function createRuntimeContextCapture() {
  const register = vi.fn<ChannelRuntimeSurface["runtimeContexts"]["register"]>(() => ({
    dispose: vi.fn(),
  }));
  return {
    channelRuntime: {
      inbound: { buildContext: buildChannelInboundEventContext },
      runtimeContexts: {
        register,
        get: vi.fn(),
        watch: vi.fn(() => () => {}),
      },
    } as unknown as ChannelRuntimeSurface,
    register,
  };
}

describe("slack startup user allowlist resolution", () => {
  it.each(["allowBots", "room users"] as const)(
    "delivers an allowed bot's reply by default and stops subsequent turns after %s revocation",
    async (revokedPolicy) => {
      const initial: OpenClawConfig = slackConfig({
        groupPolicy: "open",
        historyLimit: 0,
        streaming: { mode: "off" },
        channels: { C123: { requireMention: true, users: ["B123BOT"] } },
      });
      await resetSlackTestState(initial);
      setRuntimeConfigSnapshot(initial, initial);
      getSlackClient().conversations.info.mockResolvedValue({
        channel: { name: "releases", is_channel: true },
      });
      replyMock.mockResolvedValue({ text: "Release is ready." });
      await withMonitor(async (handler) => {
        // Core dedupe survives monitor replacement; each case uses distinct Slack messages.
        const timestampPrefix = revokedPolicy === "allowBots" ? "202" : "203";
        const receive = (botId: string, sequence: string) =>
          runSlackHandlerWithDispatch(handler, {
            event: {
              type: "message",
              subtype: "bot_message",
              bot_id: botId,
              text: "<@bot-user> release status",
              ts: `${timestampPrefix}.${sequence}`,
              channel: "C123",
              channel_type: "channel",
            },
          });

        await receive("B123BOT", "001");
        expect(replyMock).toHaveBeenCalledTimes(1);
        expect(replyMock.mock.calls[0]?.[0]).toMatchObject({ SenderIsBot: true });
        expect(sendMock).toHaveBeenCalledExactlyOnceWith(
          "channel:C123",
          "Release is ready.",
          expect.objectContaining({ accountId: "default" }),
        );

        replyMock.mockClear();
        sendMock.mockClear();
        await receive("BDENIED", "002");
        expect([replyMock.mock.calls, sendMock.mock.calls]).toEqual([[], []]);

        const revoked: OpenClawConfig = slackConfig({
          ...initial.channels?.slack,
          ...(revokedPolicy === "allowBots"
            ? { allowBots: false }
            : { channels: { C123: { requireMention: true, users: ["UOTHER"] } } }),
        });
        setRuntimeConfigSnapshot(revoked, revoked);
        await receive("B123BOT", "003");
        expect([replyMock.mock.calls, sendMock.mock.calls]).toEqual([[], []]);
        expect(appStopMock).not.toHaveBeenCalled();
      });
    },
  );

  it("rejects a sender revoked while workspace policy resolution is pending", async () => {
    const initial: OpenClawConfig = slackConfig({
      dangerouslyAllowNameMatching: true,
      dmPolicy: "allowlist",
      allowFrom: ["UOLD"],
    });
    await resetSlackTestState(initial);
    setRuntimeConfigSnapshot(initial, initial);
    replyMock.mockResolvedValue({ text: "ok" });
    const lookup = createDeferred<Array<{ input: string; resolved: boolean }>>();
    const monitor = startSlackMonitor(monitorSlackProvider);
    try {
      const handler = await getSlackHandlerOrThrow("message");
      await flush();
      const send = async (user: string, ts: string) => handler(userEvent(user, ts, "D123", "im"));
      await send("UOLD", "201.001");
      expect(replyMock).toHaveBeenCalledTimes(1);
      const resolving = slackConfig({ ...initial.channels?.slack, allowFrom: ["UOLD", "@lookup"] });
      resolveSlackUserAllowlistMock.mockImplementationOnce(() => lookup.promise);
      setRuntimeConfigSnapshot(resolving, resolving);
      const pending = send("UOLD", "201.002");
      await vi.waitFor(() =>
        expect(resolveSlackUserAllowlistMock).toHaveBeenLastCalledWith(
          expect.objectContaining({ entries: ["UOLD", "@lookup"] }),
        ),
      );
      expect(replyMock).toHaveBeenCalledTimes(1);
      const revoked = slackConfig({ ...initial.channels?.slack, allowFrom: ["UNEW"] });
      setRuntimeConfigSnapshot(revoked, revoked);
      lookup.resolve([]);
      await pending;
      expect(replyMock).toHaveBeenCalledTimes(1);
      await send("UNEW", "201.003");
      expect(replyMock).toHaveBeenCalledTimes(2);
      expect(appStopMock).not.toHaveBeenCalled();
    } finally {
      lookup.resolve([]);
      await stopSlackMonitor(monitor);
    }
  });

  it("registers one native approval client per Enterprise Grid team", async () => {
    await resetSlackTestState(
      approvalConfig({
        appToken: "xapp-1-A123-test",
        dmPolicy: "disabled",
        groupPolicy: "open",
        execApprovals: { enabled: true, approvers: ["U123OWNER"], target: "both" },
      }),
    );
    getSlackClient().auth.test.mockResolvedValueOnce({
      user_id: "UENTERPRISE",
      bot_id: "BENTERPRISE",
      enterprise_id: "E123",
      app_id: "A123",
      is_enterprise_install: true,
    });
    const { channelRuntime, register } = createRuntimeContextCapture();

    await withMonitor(
      async () => {
        await flush();

        const registration = vi.mocked(register).mock.calls[0]?.[0] as
          | { context?: { resolveClient?: (teamId?: string) => unknown } }
          | undefined;
        const resolveClient = registration?.context?.resolveClient;
        expect(resolveClient).toBeTypeOf("function");
        const teamOne = resolveClient?.("T111") as { teamId?: string };
        expect(resolveClient?.("T111")).toBe(teamOne);
        const teamTwo = resolveClient?.("T222") as { teamId?: string };

        expect(teamTwo).not.toBe(teamOne);
        expect([teamOne.teamId, teamTwo.teamId]).toEqual(["T111", "T222"]);
      },
      { channelRuntime, appToken: "xapp-1-A123-test" },
    );
  });

  it("registers the native approval runtime for plugin-only Slack approvals", async () => {
    await resetSlackTestState({
      ...approvalConfig({
        allowFrom: ["U123OWNER"],
        execApprovals: { enabled: false, approvers: ["U999EXEC"], target: "both" },
      }),
      approvals: {
        plugin: {
          enabled: true,
          mode: "targets",
          targets: [{ channel: "slack", to: "U123OWNER" }],
        },
      },
    });
    const { channelRuntime, register } = createRuntimeContextCapture();

    await withMonitor(
      async () => {
        await flush();

        expect(register).toHaveBeenCalledWith(
          expect.objectContaining({
            channelId: "slack",
            accountId: "default",
            capability: CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY,
            context: expect.objectContaining({
              config: expect.objectContaining({ enabled: false }),
              workspaceTeamId: "T_TEST",
            }),
          }),
        );
      },
      { channelRuntime },
    );
  });

  it("skips user entry resolution when name matching is not enabled", async () => {
    await resetSlackTestState({
      messages: { responsePrefix: "PFX" },
      ...slackConfig({
        dmPolicy: "allowlist",
        allowFrom: ["<@U123GLOBAL>", "@global-user"],
        channels: {
          C123: {
            enabled: true,
            requireMention: false,
            users: ["<@U123CHANNEL>", "@channel-user"],
          },
        },
      }),
    });
    replyMock.mockResolvedValue({ text: "ok" });

    await withMonitor(async (handler) => {
      await flush();
      await flush();

      expect(resolveSlackUserAllowlistMock).not.toHaveBeenCalled();

      await handler(userEvent("U123GLOBAL", "100.000", "D123", "im"));
      expect(replyMock).toHaveBeenCalledTimes(1);

      replyMock.mockClear();
      await handler(userEvent("U123CHANNEL", "101.000", "C123", "channel"));
      expect(replyMock).toHaveBeenCalledTimes(1);
    });
  });
});
