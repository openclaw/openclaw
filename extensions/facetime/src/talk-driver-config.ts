import { resolveDefaultAgentId } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  buildRealtimeVoiceAgentConsultPolicyInstructions,
  getRealtimeVoiceProvider,
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  REALTIME_VOICE_AGENT_CONSULT_SENDER_AUTH_VERSION,
  resolveConfiguredRealtimeVoiceProvider,
} from "openclaw/plugin-sdk/realtime-voice";
import { parseAgentSessionKey, resolveAgentIdFromSessionKey } from "openclaw/plugin-sdk/routing";
import { resolveConfiguredSecretInputString } from "openclaw/plugin-sdk/secret-input-runtime";
import type { FaceTimeConfig } from "./config.js";

export const CONSULT_SYSTEM_PROMPT = [
  "You are the configured OpenClaw agent receiving a delegated request from a configured owner in an operator-confirmed private 1:1 FaceTime call.",
  "An authenticated operator explicitly authorized this attachment for the configured owner/user described by this agent's workspace context, including USER.md. Do not claim macOS independently authenticated the remote caller.",
  "Use the normal workspace, memory, tools, and approval policies for this agent.",
  "Prefer registered OpenClaw tools over exec.",
  "When a direct tool returns usable data that answers the caller, answer immediately from that result.",
  "Do not contact another agent or session merely to enrich or double-check a successful direct tool result unless the caller explicitly asks you to.",
  "Never claim completion unless the relevant tool result confirms it.",
  "Return a concise plain-text answer. The realtime voice provider speaks your answer; do not call tts or generate an audio attachment.",
].join(" ");
export const INPUT_AUDIO_STATUS_INTERVAL_MS = 1_000;
export const REALTIME_READY_TIMEOUT_MS = 15_000;
export const MAX_TRANSCRIPT_ENTRY_CHARS = 2_000;
export const MAX_TRANSCRIPT_CHARS = 12_000;
export const AGENT_CONSULT_MESSAGE_PROVIDER = "voice";

export function assertAuthenticatedSenderConsultSupport(): void {
  if (REALTIME_VOICE_AGENT_CONSULT_SENDER_AUTH_VERSION !== 1) {
    throw new Error(
      "OpenClaw host does not support authenticated sender identity for realtime agent consults; update OpenClaw before enabling FaceTime",
    );
  }
}

export function agentIdFromSessionKey(sessionKey: string, config: OpenClawConfig): string {
  if (parseAgentSessionKey(sessionKey)) {
    return resolveAgentIdFromSessionKey(sessionKey);
  }
  return resolveAgentIdFromSessionKey(sessionKey, resolveDefaultAgentId(config));
}

export function buildRealtimeInstructions(params: {
  instructions: string | undefined;
  bootstrapContext: string | undefined;
  toolPolicy: FaceTimeConfig["realtime"]["toolPolicy"];
}): string {
  const callControlInstructions = [
    "Call control:",
    "- You cannot end the Apple FaceTime carrier call. If the caller asks to hang up, say briefly that the operator must end the call in FaceTime.",
    `- Never delegate a current-call hangup request to ${REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME} or claim the carrier ended.`,
  ].join("\n");
  const proxyInstructions =
    params.toolPolicy === "none"
      ? undefined
      : [
          "Mode: OpenClaw agent proxy.",
          "You are the realtime voice surface for the same configured OpenClaw agent the owner can message directly.",
          "An authenticated operator approved this attachment for the configured owner/user described by the loaded workspace profile context. Do not claim FaceTime exposed independently verified remote identity.",
          "Answer greetings, acknowledgements, and questions about your own identity or persona directly from the loaded realtime profile context.",
          "Do not mention a backend, supervisor, helper, or separate system. Present the result as your own work.",
          `Delegate actions, tool work, current facts, memory, workspace context not already loaded above, and user-specific context with ${REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME}.`,
          "Do not block, refuse, or downscope at the voice layer. Delegate to OpenClaw and treat its result as authoritative.",
          'While waiting for a tool result, use at most one short natural backchannel such as "one sec"; do not repeat progress updates or treat it as the final answer.',
          "Never claim you retried or are retrying unless a new tool result explicitly confirms a new attempt.",
          buildRealtimeVoiceAgentConsultPolicyInstructions({
            toolPolicy: params.toolPolicy,
            consultPolicy: "substantive",
          }),
        ]
          .filter(Boolean)
          .join("\n");
  return [
    params.instructions?.trim(),
    params.bootstrapContext?.trim(),
    callControlInstructions,
    proxyInstructions,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export async function resolveFaceTimeRealtimeProvider(params: {
  config: FaceTimeConfig;
  fullConfig: OpenClawConfig;
  agentId: string;
}) {
  const configuredProviderId = params.config.realtime.provider;
  const sourceProviders = params.config.realtime.providers;
  const selectedProviderIds = configuredProviderId
    ? new Set([
        configuredProviderId,
        getRealtimeVoiceProvider(configuredProviderId, params.fullConfig)?.id,
      ])
    : undefined;
  const selectedEntries = configuredProviderId
    ? Object.entries(sourceProviders).filter(([providerId]) => selectedProviderIds?.has(providerId))
    : Object.entries(sourceProviders);
  const providers = Object.fromEntries(
    await Promise.all(
      selectedEntries.map(async ([providerId, providerConfig]) => {
        const resolved = await resolveConfiguredSecretInputString({
          config: params.fullConfig,
          env: process.env,
          value: providerConfig.apiKey,
          path: `plugins.entries.facetime.config.realtime.providers.${providerId}.apiKey`,
        });
        if (resolved.value) {
          return [providerId, { ...providerConfig, apiKey: resolved.value }] as const;
        }
        if (resolved.unresolvedRefReason) {
          if (configuredProviderId) {
            throw new Error(resolved.unresolvedRefReason);
          }
          const { apiKey: _unresolvedApiKey, ...remainingConfig } = providerConfig;
          return [providerId, remainingConfig] as const;
        }
        return [providerId, { ...providerConfig }] as const;
      }),
    ),
  );
  return resolveConfiguredRealtimeVoiceProvider({
    configuredProviderId,
    providerConfigs: providers,
    providerConfigOverrides: params.config.realtime.voice
      ? { voice: params.config.realtime.voice }
      : undefined,
    cfg: params.fullConfig,
    agentId: params.agentId,
    defaultModel: params.config.realtime.model,
    surface: "bridge",
    noRegisteredProviderMessage: "No realtime voice provider registered",
  });
}
