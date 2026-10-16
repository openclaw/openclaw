import { CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY } from "openclaw/plugin-sdk/approval-handler-adapter-runtime";
import type { ChannelRuntimeSurface } from "openclaw/plugin-sdk/channel-contract";
import { buildChannelInboundEventContext } from "openclaw/plugin-sdk/channel-inbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
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
const slackTestState = getSlackTestState();

beforeEach(async () => {
  await resetSlackTestState();
});

afterEach(() => clearRuntimeConfigSnapshot());

function createRuntimeContextCapture(): {
  channelRuntime: ChannelRuntimeSurface;
  register: ChannelRuntimeSurface["runtimeContexts"]["register"];
} {
  const register = vi.fn(() => ({ dispose: vi.fn() }));
  return {
    channelRuntime: {
      inbound: {
        buildContext: buildChannelInboundEventContext,
      },
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
      const initial: OpenClawConfig = {
        channels: {
          slack: {
            enabled: true,
            groupPolicy: "open",
            historyLimit: 0,
            streaming: { mode: "off" },
            channels: { C123: { requireMention: true, users: ["B123BOT"] } },
          },
        },
      };
      await resetSlackTestState(initial);
      setRuntimeConfigSnapshot(initial, initial);
      getSlackClient().conversations.info.mockResolvedValue({
        channel: { name: "releases", is_channel: true },
      });
      slackTestState.replyMock.mockResolvedValue({ text: "Release is ready." });
      const monitor = startSlackMonitor(monitorSlackProvider);
      try {
        const handler = await getSlackHandlerOrThrow("message");
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
        expect(slackTestState.replyMock).toHaveBeenCalledTimes(1);
        expect(slackTestState.replyMock.mock.calls[0]?.[0]).toMatchObject({ SenderIsBot: true });
        expect(slackTestState.sendMock).toHaveBeenCalledExactlyOnceWith(
          "channel:C123",
          "Release is ready.",
          expect.objectContaining({ accountId: "default" }),
        );

        slackTestState.replyMock.mockClear();
        slackTestState.sendMock.mockClear();
        await receive("BDENIED", "002");
        expect(slackTestState.replyMock).not.toHaveBeenCalled();
        expect(slackTestState.sendMock).not.toHaveBeenCalled();

        const revoked: OpenClawConfig = {
          channels: {
            slack: {
              ...initial.channels?.slack,
              ...(revokedPolicy === "allowBots"
                ? { allowBots: false }
                : { channels: { C123: { requireMention: true, users: ["UOTHER"] } } }),
            },
          },
        };
        setRuntimeConfigSnapshot(revoked, revoked);
        await receive("B123BOT", "003");
        expect(slackTestState.replyMock).not.toHaveBeenCalled();
        expect(slackTestState.sendMock).not.toHaveBeenCalled();
        expect(slackTestState.appStopMock).not.toHaveBeenCalled();
      } finally {
        await stopSlackMonitor(monitor);
      }
    },
  );

  it("rejects a sender revoked while workspace policy resolution is pending", async () => {
    const initial: OpenClawConfig = {
      channels: {
        slack: {
          enabled: true,
          dangerouslyAllowNameMatching: true,
          dmPolicy: "allowlist",
          allowFrom: ["UOLD"],
        },
      },
    };
    await resetSlackTestState(initial);
    setRuntimeConfigSnapshot(initial, initial);
    slackTestState.replyMock.mockResolvedValue({ text: "ok" });
    const lookup = createDeferred<Array<{ input: string; resolved: boolean }>>();
    const monitor = startSlackMonitor(monitorSlackProvider);
    try {
      const handler = await getSlackHandlerOrThrow("message");
      await flush();
      const send = async (user: string, ts: string) =>
        handler({
          event: { type: "message", user, ts, text: "hello", channel: "D123", channel_type: "im" },
        });
      await send("UOLD", "201.001");
      expect(slackTestState.replyMock).toHaveBeenCalledTimes(1);
      const resolving: OpenClawConfig = {
        channels: { slack: { ...initial.channels?.slack, allowFrom: ["UOLD", "@lookup"] } },
      };
      slackTestState.resolveSlackUserAllowlistMock.mockImplementationOnce(() => lookup.promise);
      setRuntimeConfigSnapshot(resolving, resolving);
      const pending = send("UOLD", "201.002");
      await vi.waitFor(() =>
        expect(slackTestState.resolveSlackUserAllowlistMock).toHaveBeenLastCalledWith(
          expect.objectContaining({ entries: ["UOLD", "@lookup"] }),
        ),
      );
      expect(slackTestState.replyMock).toHaveBeenCalledTimes(1);
      const revoked: OpenClawConfig = {
        channels: { slack: { ...initial.channels?.slack, allowFrom: ["UNEW"] } },
      };
      setRuntimeConfigSnapshot(revoked, revoked);
      lookup.resolve([]);
      await pending;
      expect(slackTestState.replyMock).toHaveBeenCalledTimes(1);
      await send("UNEW", "201.003");
      expect(slackTestState.replyMock).toHaveBeenCalledTimes(2);
      expect(slackTestState.appStopMock).not.toHaveBeenCalled();
    } finally {
      lookup.resolve([]);
      await stopSlackMonitor(monitor);
    }
  });

  it("registers one native approval client per Enterprise Grid team", async () => {
    await resetSlackTestState({
      channels: {
        slack: {
          enabled: true,
          botToken: "xoxb-test",
          appToken: "xapp-1-A123-test",
          dmPolicy: "disabled",
          groupPolicy: "open",
          execApprovals: {
            enabled: true,
            approvers: ["U123OWNER"],
            target: "both",
          },
        },
      },
    });
    getSlackClient().auth.test.mockResolvedValueOnce({
      user_id: "UENTERPRISE",
      bot_id: "BENTERPRISE",
      enterprise_id: "E123",
      app_id: "A123",
      is_enterprise_install: true,
    });
    const { channelRuntime, register } = createRuntimeContextCapture();

    const monitor = startSlackMonitor(monitorSlackProvider, {
      channelRuntime,
      appToken: "xapp-1-A123-test",
    });
    try {
      await getSlackHandlerOrThrow("message");
      await flush();

      const registration = vi.mocked(register).mock.calls[0]?.[0] as
        | { context?: { resolveClient?: (teamId?: string) => unknown } }
        | undefined;
      const resolveClient = registration?.context?.resolveClient;
      expect(resolveClient).toBeTypeOf("function");
      const teamOne = resolveClient?.("T111") as { teamId?: string };
      const teamOneAgain = resolveClient?.("T111") as { teamId?: string };
      const teamTwo = resolveClient?.("T222") as { teamId?: string };

      expect(teamOneAgain).toBe(teamOne);
      expect(teamTwo).not.toBe(teamOne);
      expect(teamOne.teamId).toBe("T111");
      expect(teamTwo.teamId).toBe("T222");
    } finally {
      await stopSlackMonitor(monitor);
    }
  });

  it("registers the native approval runtime for plugin-only Slack approvals", async () => {
    await resetSlackTestState({
      channels: {
        slack: {
          enabled: true,
          botToken: "xoxb-test",
          appToken: "xapp-test",
          allowFrom: ["U123OWNER"],
          execApprovals: {
            enabled: false,
            approvers: ["U999EXEC"],
            target: "both",
          },
        },
      },
      approvals: {
        plugin: {
          enabled: true,
          mode: "targets",
          targets: [{ channel: "slack", to: "U123OWNER" }],
        },
      },
    });
    const { channelRuntime, register } = createRuntimeContextCapture();

    const monitor = startSlackMonitor(monitorSlackProvider, { channelRuntime });
    try {
      await getSlackHandlerOrThrow("message");
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
    } finally {
      await stopSlackMonitor(monitor);
    }
  });

  it("skips user entry resolution when name matching is not enabled", async () => {
    await resetSlackTestState({
      messages: {
        responsePrefix: "PFX",
      },
      channels: {
        slack: {
          enabled: true,
          dmPolicy: "allowlist",
          allowFrom: ["<@U123GLOBAL>", "@global-user"],
          channels: {
            C123: {
              enabled: true,
              requireMention: false,
              users: ["<@U123CHANNEL>", "@channel-user"],
            },
          },
        },
      },
    });
    slackTestState.replyMock.mockResolvedValue({ text: "ok" });

    const monitor = startSlackMonitor(monitorSlackProvider);
    try {
      const handler = await getSlackHandlerOrThrow("message");
      await flush();
      await flush();

      expect(slackTestState.resolveSlackUserAllowlistMock).not.toHaveBeenCalled();

      await handler({
        event: {
          type: "message",
          user: "U123GLOBAL",
          text: "hello",
          ts: "100.000",
          channel: "D123",
          channel_type: "im",
        },
      });
      expect(slackTestState.replyMock).toHaveBeenCalledTimes(1);

      slackTestState.replyMock.mockClear();
      await handler({
        event: {
          type: "message",
          user: "U123CHANNEL",
          text: "hello",
          ts: "101.000",
          channel: "C123",
          channel_type: "channel",
        },
      });
      expect(slackTestState.replyMock).toHaveBeenCalledTimes(1);
    } finally {
      await stopSlackMonitor(monitor);
    }
  });
});
