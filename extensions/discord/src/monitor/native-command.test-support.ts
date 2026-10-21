import { ChannelType } from "discord-api-types/v10";
import * as channelInbound from "openclaw/plugin-sdk/channel-inbound";
import type { NativeCommandSpec } from "openclaw/plugin-sdk/command-auth-native";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { expect, vi } from "vitest";
import {
  createMockCommandInteraction,
  type MockCommandInteraction,
} from "./native-command.test-helpers.js";

export const guildId = "345678901234567890";
export const channelId = "234567890123456789";
export const statusCommand: NativeCommandSpec = {
  name: "status",
  description: "Status",
  acceptsArgs: false,
};
export const cronCommand: NativeCommandSpec = {
  name: "cron_jobs",
  description: "List cron jobs",
  acceptsArgs: false,
};
export function createConfig(): OpenClawConfig {
  return { channels: { discord: { dm: { enabled: true }, dmPolicy: "open", allowFrom: ["*"] } } };
}
export function guildConfig(commands: OpenClawConfig["commands"]): OpenClawConfig {
  return {
    commands,
    channels: {
      discord: {
        groupPolicy: "allowlist",
        guilds: {
          [guildId]: { channels: { [channelId]: { enabled: true, requireMention: false } } },
        },
      },
    },
  };
}
export function guildInteraction() {
  const interaction = createMockCommandInteraction({
    channelType: ChannelType.GuildText,
    channelId,
    guildId,
    guildName: "Test Guild",
    userId: "999999999999999999",
  });
  interaction.options.getString.mockReturnValue("now");
  return interaction;
}

type InboundPlan = Parameters<typeof channelInbound.dispatchChannelInboundTurn>[0];
type DispatchResult = Extract<
  Awaited<ReturnType<typeof channelInbound.dispatchChannelInboundTurn>>,
  { dispatched: true }
>["dispatchResult"];
export const emptyDispatchResult = { counts: { final: 0, block: 0, tool: 0 }, queuedFinal: false };
export function dispatchedTurn(
  plan: Pick<InboundPlan, "ctxPayload" | "route">,
  dispatchResult: DispatchResult,
) {
  return {
    admission: { kind: "dispatch" as const },
    dispatched: true as const,
    ctxPayload: plan.ctxPayload,
    routeSessionKey: plan.route.sessionKey,
    dispatchResult,
  };
}
export function interceptDelivery(run: (plan: InboundPlan) => Promise<DispatchResult | void>) {
  vi.spyOn(channelInbound, "dispatchChannelInboundTurn").mockImplementation(async (plan) =>
    dispatchedTurn(plan, (await run(plan)) ?? emptyDispatchResult),
  );
}
export function directDelivery(plan: InboundPlan) {
  if (!("deliver" in plan.delivery) || !plan.delivery.deliver) {
    throw new Error("expected direct deliverer");
  }
  return plan.delivery.deliver;
}

export function expectSingleCallFirstArg(
  mock: { mock: { calls: unknown[][] } },
  expected: Record<string, unknown>,
) {
  expect(mock.mock.calls).toHaveLength(1);
  expect(mock.mock.calls[0]?.[0]).toEqual(expect.objectContaining(expected));
}
export function expectNoFollowUpContent(interaction: MockCommandInteraction, content: string) {
  expect(interaction.followUp).not.toHaveBeenCalledWith(expect.objectContaining({ content }));
}
export function expectSilentSettlement(interaction: MockCommandInteraction) {
  expect(interaction.followUp).not.toHaveBeenCalled();
  expect(interaction.reply).not.toHaveBeenCalled();
  expect(interaction.deleteReply).toHaveBeenCalledTimes(1);
}
export function expectEmptyWarning(interaction: MockCommandInteraction) {
  expectSingleCallFirstArg(interaction.followUp, {
    content: "⚠️ Command produced no visible reply.",
    ephemeral: true,
  });
  expect(interaction.reply).not.toHaveBeenCalled();
  expect(interaction.deleteReply).not.toHaveBeenCalled();
}
