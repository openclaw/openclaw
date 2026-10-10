import { randomUUID } from "node:crypto";
import type { DiscordAccountConfig, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import * as realtimeBootstrapSdk from "openclaw/plugin-sdk/realtime-bootstrap-context";
import { resolveRealtimeBootstrapContextInstructions } from "openclaw/plugin-sdk/realtime-bootstrap-context";
import type { RealtimeVoiceSelectionHandle } from "openclaw/plugin-sdk/realtime-voice";
import { createSubsystemLogger, type RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { Client } from "../internal/discord.js";
import { formatMention } from "../mentions.js";
import { normalizeDiscordSlug } from "../monitor/allow-list.js";
import { buildDiscordGroupSystemPrompt } from "../monitor/inbound-context.js";
import type { DiscordLivePolicyReader } from "../monitor/live-policy.js";
import { getDiscordRuntime } from "../runtime.js";
import { authorizeDiscordVoiceIngress } from "./access.js";
import type { VoiceRealtimeSpeakerContext, VoiceSessionEntry } from "./session.js";
import type { DiscordVoiceSpeakerContextResolver } from "./speaker-context.js";

const DISCORD_VOICE_MESSAGE_PROVIDER = "discord-voice";

const logger = createSubsystemLogger("discord/voice");

// Retire the 2026.9.6 profile path when the supported host floor supplies the shared composer.
const contextSdk: Partial<
  Pick<typeof realtimeBootstrapSdk, "resolveRealtimeVoiceAgentContextInstructions">
> = realtimeBootstrapSdk;

export type DiscordVoiceIngressContext = VoiceRealtimeSpeakerContext & {
  isCurrent?: () => boolean;
};

type DiscordVoiceAgentTurnResult = Awaited<
  ReturnType<ReturnType<typeof getDiscordRuntime>["agent"]["runCommandFromIngress"]>
>;

function summarizeAgentTurnPayloads(
  payloads: NonNullable<DiscordVoiceAgentTurnResult["payloads"]>,
): string {
  const nonEmptyTextPayloads = payloads.filter((payload) => payload.text.trim()).length;
  const errorPayloads = payloads.filter((payload) => payload.isError === true).length;
  const mediaPayloads = payloads.filter(
    (payload) => payload.mediaUrl != null || payload.mediaUrls?.length,
  ).length;

  return `payloadCount=${payloads.length} textPayloads=${payloads.length} nonEmptyTextPayloads=${nonEmptyTextPayloads} reasoningPayloads=0 errorPayloads=${errorPayloads} mediaPayloads=${mediaPayloads}`;
}

export async function resolveDiscordVoiceIngressContext(params: {
  readPolicy?: DiscordLivePolicyReader;
  entry: VoiceSessionEntry;
  userId: string;
  cfg: OpenClawConfig;
  discordConfig: DiscordAccountConfig;
  admissionAllowFrom?: string[];
  client: Client;
  speakerContext: DiscordVoiceSpeakerContextResolver;
}): Promise<DiscordVoiceIngressContext | null> {
  const { entry, userId } = params;
  if (!entry.guildName) {
    const guild = await params.client.fetchGuild(entry.guildId).catch(() => null);
    entry.guildName =
      guild && typeof guild.name === "string" && guild.name.trim() ? guild.name : undefined;
  }
  const speaker = await params.speakerContext.resolveContext(entry.guildId, userId);
  const speakerIdentity = await params.speakerContext.resolveIdentity(entry.guildId, userId);
  const access = await authorizeDiscordVoiceIngress({
    readPolicy: params.readPolicy,
    cfg: params.cfg,
    discordConfig: params.discordConfig,
    guildName: entry.guildName,
    guildId: entry.guildId,
    channelId: entry.channelId,
    channelName: entry.channelName,
    channelSlug: entry.channelName ? normalizeDiscordSlug(entry.channelName) : "",
    channelLabel: formatMention({ channelId: entry.channelId }),
    memberRoleIds: speakerIdentity.memberRoleIds,
    admissionAllowFrom: params.admissionAllowFrom,
    sender: {
      id: speakerIdentity.id,
      name: speakerIdentity.name,
      tag: speakerIdentity.tag,
    },
  });
  if (!access.ok) {
    return null;
  }
  return {
    extraSystemPrompt: buildDiscordGroupSystemPrompt(access.channelConfig),
    isCurrent: access.isCurrent,
    senderIsOwner: speaker.senderIsOwner,
    speakerLabel: speaker.label,
  };
}

export async function runDiscordVoiceAgentTurn(params: {
  entry: VoiceSessionEntry;
  accountId: string;
  userId: string;
  message: string;
  discordConfig: DiscordAccountConfig;
  runtime: RuntimeEnv;
  context: DiscordVoiceIngressContext;
  toolsAllow?: string[];
  voiceSelection?: RealtimeVoiceSelectionHandle;
  signal?: AbortSignal;
}): Promise<string | null> {
  const { context } = params;
  if (
    params.entry.captureOnly ||
    params.entry.sessionLifecycle.status !== "active" ||
    context.isCurrent?.() === false
  ) {
    return null;
  }
  params.signal?.throwIfAborted();
  const voiceModel = normalizeOptionalString(params.discordConfig.voice?.model);
  const runId = params.voiceSelection ? randomUUID() : undefined;
  const unbind = runId
    ? params.voiceSelection?.bindRun({
        runId,
        assertCurrent: () => {
          params.signal?.throwIfAborted();
          if (
            params.entry.sessionLifecycle.status !== "active" ||
            context.isCurrent?.() === false
          ) {
            throw new Error("Discord voice access is no longer valid for this call");
          }
        },
      })
    : undefined;
  let result: DiscordVoiceAgentTurnResult;
  try {
    result = await getDiscordRuntime().agent.runCommandFromIngress(
      {
        message: params.message,
        sessionKey: params.entry.route.sessionKey,
        agentId: params.entry.route.agentId,
        messageChannel: "discord",
        messageProvider: DISCORD_VOICE_MESSAGE_PROVIDER,
        accountId: params.accountId,
        extraSystemPrompt: context.extraSystemPrompt,
        senderIsOwner: context.senderIsOwner,
        allowModelOverride: Boolean(voiceModel),
        model: voiceModel,
        toolsAllow: params.toolsAllow,
        deliver: false,
        ...(runId ? { runId } : {}),
        ...(params.signal ? { abortSignal: params.signal } : {}),
      },
      params.runtime,
    );
  } finally {
    unbind?.();
  }
  const payloads = result.payloads ?? [];
  const text = payloads
    .map((payload) => payload.text)
    .filter((entry) => entry?.trim())
    .join("\n")
    .trim();
  if (!text) {
    logger.info(
      `discord voice: agent turn produced no speakable payloads guild=${params.entry.guildId} channel=${params.entry.channelId} voiceSession=${params.entry.voiceSessionKey} supervisorSession=${params.entry.route.sessionKey} agent=${params.entry.route.agentId} user=${params.userId} ${summarizeAgentTurnPayloads(payloads)}`,
    );
  }
  return text;
}

export async function resolveDiscordVoiceRealtimeAgentContext(params: {
  entry: { route: Pick<VoiceSessionEntry["route"], "agentId" | "sessionKey"> };
  cfg: OpenClawConfig;
  discordConfig: DiscordAccountConfig;
}): Promise<string | undefined> {
  const contextParams = {
    config: params.cfg,
    agentId: params.entry.route.agentId,
    sessionKey: params.entry.route.sessionKey,
    files: params.discordConfig.voice?.realtime?.bootstrapContextFiles,
    warn: (message: string) => logger.warn(`discord voice: realtime agent context: ${message}`),
  };
  if (contextSdk.resolveRealtimeVoiceAgentContextInstructions) {
    return await contextSdk.resolveRealtimeVoiceAgentContextInstructions(contextParams);
  }
  if (contextParams.files?.length === 0) {
    return undefined;
  }
  try {
    return await resolveRealtimeBootstrapContextInstructions({
      ...contextParams,
      warn: (message) => logger.warn(`discord voice: realtime bootstrap context: ${message}`),
    });
  } catch (error) {
    logger.warn(
      `discord voice: realtime bootstrap context unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}
