import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { QaRunnerCliRegistration } from "openclaw/plugin-sdk/qa-runner-runtime";
import {
  patchLiveQaGatewayConfig,
  readLiveQaGatewayConfig,
} from "../shared/live-gateway-config.runtime.js";
import type { DiscordUser, DiscordObservedMessage } from "./discord-live.evidence.js";
import {
  type DiscordChannel,
  type DiscordQaScenarioImplementation,
  type DiscordQaScenarioRun,
  type DiscordQaRuntimeEnv,
  buildDiscordQaConfig,
  resolveDiscordQaVoiceChannel,
  waitForDiscordChannelRunning,
} from "./discord-live.runtime.js";

type AdapterFactory = NonNullable<QaRunnerCliRegistration["adapterFactory"]>;
type AdapterDefinition = Awaited<ReturnType<AdapterFactory["create"]>>;
type FlowPreparationInput = Parameters<NonNullable<AdapterDefinition["prepareFlow"]>>[0];
export type DiscordQaScenarioEnvironment = {
  configureScenario: (implementation: DiscordQaScenarioImplementation) => Promise<{
    cfg: OpenClawConfig;
    configureTranscriptVoiceAccess?: (authorized: boolean) => Promise<void>;
    run: DiscordQaScenarioRun;
    voiceChannel?: DiscordChannel;
  }>;
  driverIdentity: DiscordUser;
  observedMessages: DiscordObservedMessage[];
  outputDir: string;
  runtimeEnv: DiscordQaRuntimeEnv;
  scenario: { id: string; timeoutMs: number; title: string };
  sutAccountId: string;
  sutIdentity: DiscordUser;
};

export function createDiscordQaScenarioEnvironment(params: {
  accountId: string;
  driverIdentity: DiscordUser;
  runtimeEnv: DiscordQaRuntimeEnv;
  sutIdentity: DiscordUser;
}) {
  const observedMessages: DiscordObservedMessage[] = [];
  const prepareFlow = async (input: FlowPreparationInput) => {
    return {
      discordScenarioContext: {
        configureScenario: async (implementation: DiscordQaScenarioImplementation) => {
          const run = implementation.buildRun(params.runtimeEnv.sutApplicationId);
          if (run.kind === "transcripts-voice-authorization" && !params.runtimeEnv.voiceChannelId) {
            throw new Error(
              "Discord transcript authorization requires an explicit QA voiceChannelId in the leased credential or OPENCLAW_QA_DISCORD_VOICE_CHANNEL_ID. Reserve a dedicated empty QA voice channel before running; automatic room discovery is not allowed and the harness does not verify room occupancy.",
            );
          }
          const voiceChannel =
            run.kind === "voice-autojoin" || run.kind === "transcripts-voice-authorization"
              ? await resolveDiscordQaVoiceChannel({
                  guildId: params.runtimeEnv.guildId,
                  token: params.runtimeEnv.sutBotToken,
                  voiceChannelId: params.runtimeEnv.voiceChannelId,
                })
              : undefined;
          const applyConfig = async (transcriptVoiceAuthorized?: boolean) => {
            const snapshot = await readLiveQaGatewayConfig(input.gateway);
            const cfg = buildDiscordQaConfig(
              snapshot.config as OpenClawConfig,
              {
                guildId: params.runtimeEnv.guildId,
                channelId: params.runtimeEnv.channelId,
                driverBotId: params.driverIdentity.id,
                sutAccountId: params.accountId,
                sutBotToken: params.runtimeEnv.sutBotToken,
              },
              {
                ...(run.kind === "voice-autojoin" && voiceChannel
                  ? {
                      voiceAutoJoin: {
                        channelId: voiceChannel.id,
                        guildId: params.runtimeEnv.guildId,
                      },
                    }
                  : {}),
                ...(run.kind === "transcripts-voice-authorization" && voiceChannel
                  ? {
                      voiceChannelAccess: {
                        channelId: voiceChannel.id,
                        users: [
                          transcriptVoiceAuthorized
                            ? params.driverIdentity.id
                            : params.sutIdentity.id,
                        ],
                      },
                    }
                  : {}),
                ...(run.kind === "progress-draft-lifecycle"
                  ? { progressDraftLabel: run.progressLabel }
                  : {}),
                statusReactionsToolOnly: run.kind === "status-reactions-tool-only",
              },
            );
            await patchLiveQaGatewayConfig({
              gateway: input.gateway,
              patch: cfg as Record<string, unknown>,
              replacePaths: [
                "channels.discord",
                "messages",
                "plugins",
                ...(run.kind === "transcripts-voice-authorization" && voiceChannel
                  ? [
                      `channels.discord.accounts.${params.accountId}.guilds.${params.runtimeEnv.guildId}.channels.${voiceChannel.id}.users`,
                    ]
                  : []),
              ],
              timeoutMs: input.timeoutMs,
              waitForConfigRestartSettle: input.waitForConfigRestartSettle,
            });
            await waitForDiscordChannelRunning(input.gateway as never, params.accountId);
            return cfg;
          };
          const cfg = await applyConfig(false);
          return {
            cfg,
            run,
            ...(run.kind === "transcripts-voice-authorization"
              ? {
                  configureTranscriptVoiceAccess: async (authorized: boolean) =>
                    void (await applyConfig(authorized)),
                }
              : {}),
            ...(voiceChannel ? { voiceChannel } : {}),
          };
        },
        driverIdentity: params.driverIdentity,
        observedMessages,
        outputDir: input.outputDir,
        runtimeEnv: params.runtimeEnv,
        scenario: {
          id: input.scenarioId,
          timeoutMs: input.timeoutMs,
          title: input.scenarioTitle,
        },
        sutAccountId: params.accountId,
        sutIdentity: params.sutIdentity,
      } satisfies DiscordQaScenarioEnvironment,
    };
  };
  return { prepareFlow };
}
