import { PassThrough } from "node:stream";
import { agentCommandFromIngress } from "openclaw/plugin-sdk/agent-runtime";
import type { DiscordAccountConfig, OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import {
  buildRealtimeVoiceAgentConsultChatMessage,
  buildRealtimeVoiceAgentConsultPolicyInstructions,
  buildRealtimeVoiceAgentConsultWorkingResponse,
  createRealtimeVoiceAgentTalkbackQueue,
  createRealtimeVoiceBridgeSession,
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
  resolveConfiguredRealtimeVoiceProvider,
  resolveRealtimeVoiceAgentConsultToolPolicy,
  resolveRealtimeVoiceAgentConsultTools,
  type RealtimeVoiceAgentTalkbackQueue,
  type RealtimeVoiceAgentConsultToolPolicy,
  type RealtimeVoiceBridgeSession,
  type RealtimeVoiceProviderConfig,
  type RealtimeVoiceToolCallEvent,
} from "openclaw/plugin-sdk/realtime-voice";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import {
  convertDiscordPcm48kStereoToRealtimePcm24kMono,
  convertRealtimePcm24kMonoToDiscordPcm48kStereo,
} from "./audio.js";
import { DISCORD_VOICE_MESSAGE_PROVIDER } from "./ingress.js";
import { formatVoiceIngressPrompt } from "./prompt.js";
import { loadDiscordVoiceSdk } from "./sdk-runtime.js";
import { logVoiceVerbose, type VoiceSessionEntry } from "./session.js";

const logger = createSubsystemLogger("discord/voice");
const DISCORD_REALTIME_TALKBACK_DEBOUNCE_MS = 350;
const DISCORD_REALTIME_FALLBACK_TEXT = "I hit an error while checking that. Please try again.";

export type DiscordVoiceMode = "stt-tts" | "talk-buffer" | "bidi";

type DiscordRealtimeSpeakerContext = {
  extraSystemPrompt?: string;
  senderIsOwner: boolean;
  speakerLabel: string;
};

type DiscordRealtimeVoiceConfig = NonNullable<DiscordAccountConfig["voice"]>["realtime"];

export function resolveDiscordVoiceMode(voice: DiscordAccountConfig["voice"]): DiscordVoiceMode {
  const mode = voice?.mode;
  return mode === "talk-buffer" || mode === "bidi" ? mode : "stt-tts";
}

export function isDiscordRealtimeVoiceMode(mode: DiscordVoiceMode): boolean {
  return mode === "talk-buffer" || mode === "bidi";
}

export function buildDiscordSpeakExactUserMessage(text: string): string {
  return [
    "Speak this exact OpenClaw answer to the Discord voice channel, without adding, removing, or rephrasing words.",
    `Answer: ${JSON.stringify(text)}`,
  ].join("\n");
}

export class DiscordRealtimeVoiceSession {
  private bridge: RealtimeVoiceBridgeSession | null = null;
  private outputStream: PassThrough | null = null;
  private readonly talkback: RealtimeVoiceAgentTalkbackQueue;
  private stopped = false;
  private speakerContext: DiscordRealtimeSpeakerContext | undefined;

  constructor(
    private readonly params: {
      cfg: OpenClawConfig;
      discordConfig: DiscordAccountConfig;
      entry: VoiceSessionEntry;
      mode: Exclude<DiscordVoiceMode, "stt-tts">;
      runtime: RuntimeEnv;
    },
  ) {
    this.talkback = createRealtimeVoiceAgentTalkbackQueue({
      debounceMs: this.realtimeConfig?.debounceMs ?? DISCORD_REALTIME_TALKBACK_DEBOUNCE_MS,
      isStopped: () => this.stopped,
      logger,
      logPrefix: "[discord] realtime agent",
      responseStyle: "Brief, natural spoken answer for a Discord voice channel.",
      fallbackText: DISCORD_REALTIME_FALLBACK_TEXT,
      consult: async ({ question, responseStyle }) => ({
        text: await this.runAgentTurn({
          message: formatVoiceIngressPrompt(
            [question, responseStyle ? `Spoken style: ${responseStyle}` : undefined]
              .filter(Boolean)
              .join("\n\n"),
            this.speakerContext?.speakerLabel ?? "Discord voice speaker",
          ),
        }),
      }),
      deliver: (text) => this.bridge?.sendUserMessage(buildDiscordSpeakExactUserMessage(text)),
    });
  }

  async connect(): Promise<void> {
    const resolved = resolveConfiguredRealtimeVoiceProvider({
      configuredProviderId: this.realtimeConfig?.provider,
      providerConfigs: buildProviderConfigs(this.realtimeConfig),
      cfg: this.params.cfg,
      defaultModel: this.realtimeConfig?.model,
      noRegisteredProviderMessage: "No configured realtime voice provider registered",
    });
    const toolPolicy = resolveRealtimeVoiceAgentConsultToolPolicy(
      this.realtimeConfig?.toolPolicy,
      "safe-read-only",
    );
    const consultPolicy = this.realtimeConfig?.consultPolicy ?? "auto";
    const instructions = buildDiscordRealtimeInstructions({
      mode: this.params.mode,
      instructions: this.realtimeConfig?.instructions,
      toolPolicy,
      consultPolicy,
    });
    this.bridge = createRealtimeVoiceBridgeSession({
      provider: resolved.provider,
      providerConfig: resolved.providerConfig,
      audioFormat: REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
      instructions,
      autoRespondToAudio: this.params.mode === "bidi",
      markStrategy: "ack-immediately",
      tools: this.params.mode === "bidi" ? resolveRealtimeVoiceAgentConsultTools(toolPolicy) : [],
      audioSink: {
        isOpen: () => !this.stopped,
        sendAudio: (audio) => this.sendOutputAudio(audio),
        clearAudio: () => this.clearOutputAudio(),
      },
      onTranscript: (role, text, isFinal) => {
        if (!isFinal || role !== "user" || this.params.mode !== "talk-buffer") {
          return;
        }
        this.talkback.enqueue(text);
      },
      onToolCall: (event, session) => this.handleToolCall(event, session),
      onEvent: (event) => {
        const detail = event.detail ? ` ${event.detail}` : "";
        logVoiceVerbose(`realtime ${event.direction}:${event.type}${detail}`);
      },
      onError: (error) =>
        logger.warn(`discord voice: realtime error: ${formatErrorMessage(error)}`),
      onClose: (reason) => logVoiceVerbose(`realtime closed: ${reason}`),
    });
    logVoiceVerbose(
      `realtime voice bridge starting: mode=${this.params.mode} provider=${resolved.provider.id}`,
    );
    await this.bridge.connect();
  }

  close(): void {
    this.stopped = true;
    this.talkback.close();
    this.clearOutputAudio();
    this.bridge?.close();
    this.bridge = null;
  }

  setSpeakerContext(context: DiscordRealtimeSpeakerContext): void {
    this.speakerContext = context;
  }

  sendInputAudio(discordPcm48kStereo: Buffer): void {
    if (!this.bridge || this.stopped) {
      return;
    }
    const realtimePcm = convertDiscordPcm48kStereoToRealtimePcm24kMono(discordPcm48kStereo);
    if (realtimePcm.length > 0) {
      this.bridge.sendAudio(realtimePcm);
    }
  }

  handleBargeIn(): void {
    this.bridge?.handleBargeIn({ audioPlaybackActive: Boolean(this.outputStream) });
    this.clearOutputAudio();
  }

  private get realtimeConfig(): DiscordRealtimeVoiceConfig {
    return this.params.discordConfig.voice?.realtime;
  }

  private sendOutputAudio(realtimePcm24kMono: Buffer): void {
    const discordPcm = convertRealtimePcm24kMonoToDiscordPcm48kStereo(realtimePcm24kMono);
    if (discordPcm.length === 0) {
      return;
    }
    const stream = this.ensureOutputStream();
    stream.write(discordPcm);
  }

  private ensureOutputStream(): PassThrough {
    if (this.outputStream && !this.outputStream.destroyed) {
      return this.outputStream;
    }
    const voiceSdk = loadDiscordVoiceSdk();
    const stream = new PassThrough();
    this.outputStream = stream;
    stream.once("close", () => {
      if (this.outputStream === stream) {
        this.outputStream = null;
      }
    });
    const resource = voiceSdk.createAudioResource(stream, {
      inputType: voiceSdk.StreamType.Raw,
    });
    this.params.entry.player.play(resource);
    return stream;
  }

  private clearOutputAudio(): void {
    const stream = this.outputStream;
    this.outputStream = null;
    stream?.end();
    stream?.destroy();
    this.params.entry.player.stop(true);
  }

  private handleToolCall(
    event: RealtimeVoiceToolCallEvent,
    session: RealtimeVoiceBridgeSession,
  ): void {
    const callId = event.callId || event.itemId;
    if (this.params.mode !== "bidi") {
      session.submitToolResult(callId, {
        error: `Tool "${event.name}" is only available in bidi Discord voice mode`,
      });
      return;
    }
    if (event.name !== REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME) {
      session.submitToolResult(callId, { error: `Tool "${event.name}" not available` });
      return;
    }
    if (session.bridge.supportsToolResultContinuation) {
      session.submitToolResult(callId, buildRealtimeVoiceAgentConsultWorkingResponse("speaker"), {
        willContinue: true,
      });
    }
    void this.runAgentTurn({ message: buildRealtimeVoiceAgentConsultChatMessage(event.args) })
      .then((text) => {
        session.submitToolResult(callId, { text });
      })
      .catch((error: unknown) => {
        session.submitToolResult(callId, { error: formatErrorMessage(error) });
      });
  }

  private async runAgentTurn(params: { message: string }): Promise<string> {
    const voiceModel = normalizeOptionalString(this.params.discordConfig.voice?.model);
    const context = this.speakerContext;
    const result = await agentCommandFromIngress(
      {
        message: params.message,
        sessionKey: this.params.entry.route.sessionKey,
        agentId: this.params.entry.route.agentId,
        messageChannel: "discord",
        messageProvider: DISCORD_VOICE_MESSAGE_PROVIDER,
        extraSystemPrompt: context?.extraSystemPrompt,
        senderIsOwner: context?.senderIsOwner ?? false,
        allowModelOverride: Boolean(voiceModel),
        model: voiceModel,
        deliver: false,
      },
      this.params.runtime,
    );
    return (result.payloads ?? [])
      .map((payload) => payload.text)
      .filter((text) => typeof text === "string" && text.trim())
      .join("\n")
      .trim();
  }
}

function buildProviderConfigs(
  realtimeConfig: DiscordRealtimeVoiceConfig,
): Record<string, RealtimeVoiceProviderConfig | undefined> | undefined {
  const configs = { ...realtimeConfig?.providers };
  const provider = realtimeConfig?.provider?.trim();
  if (!provider) {
    return Object.keys(configs).length > 0 ? configs : undefined;
  }
  const existing = configs[provider] ?? {};
  configs[provider] = {
    ...existing,
    ...(realtimeConfig?.model ? { model: realtimeConfig.model } : {}),
    ...(realtimeConfig?.voice ? { voice: realtimeConfig.voice } : {}),
  };
  return configs;
}

function buildDiscordRealtimeInstructions(params: {
  mode: Exclude<DiscordVoiceMode, "stt-tts">;
  instructions?: string;
  toolPolicy: RealtimeVoiceAgentConsultToolPolicy;
  consultPolicy: "auto" | "always";
}): string {
  const base =
    params.instructions ??
    [
      "You are OpenClaw's Discord voice interface.",
      "Keep spoken replies concise, natural, and suitable for a live Discord voice channel.",
    ].join("\n");
  if (params.mode === "talk-buffer") {
    return [
      base,
      "Mode: buffered OpenClaw agent talkback.",
      "Use audio input only to transcribe the speaker. Do not answer user speech by yourself.",
      "When OpenClaw sends an exact answer to speak, say only that answer.",
    ].join("\n\n");
  }
  return [
    base,
    buildRealtimeVoiceAgentConsultPolicyInstructions({
      toolPolicy: params.toolPolicy,
      consultPolicy: params.consultPolicy,
    }),
  ]
    .filter(Boolean)
    .join("\n\n");
}
