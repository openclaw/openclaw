// Mattermost plugin module implements STT, hidden agent turns, and TTS for calls.
import { agentCommandFromIngress, resolveAgentDir } from "openclaw/plugin-sdk/agent-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { tempWorkspace, resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { stripMarkdown } from "openclaw/plugin-sdk/text-chunking";
import { getMattermostRuntime } from "../runtime.js";
import type { OpenClawConfig, RuntimeEnv } from "./runtime-api.js";
import {
  buildMonoWav,
  decodeAudioFileToStereo48k,
  downsampleStereo48kToMono16k,
} from "./voice-audio.js";
import type { MattermostVoiceReplyAudio } from "./voice-worker.js";

const MATTERMOST_VOICE_SYSTEM_PROMPT =
  "This is a live voice conversation. Reply naturally and concisely for spoken playback. Do not mention transcription or send a separate chat message.";
const MATTERMOST_VOICE_AGENT_ERROR_TEXT =
  "There was an error processing your request. Check the logs for more information.";
const ASSISTANT_TURN_FAILED_BEFORE_CONTENT = "[assistant turn failed before producing content]";

type AgentTurnResult = {
  payloads?: Array<{ text?: string; isError?: boolean }>;
  meta?: { error?: unknown };
};

type VoiceTurnDependencies = {
  withAudioFile: <T>(samples: Int16Array, run: (filePath: string) => Promise<T>) => Promise<T>;
  transcribe: (params: {
    agentId: string;
    cfg: OpenClawConfig;
    filePath: string;
  }) => Promise<string | undefined>;
  runAgent: (
    options: Parameters<typeof agentCommandFromIngress>[0],
    runtime: RuntimeEnv,
  ) => Promise<AgentTurnResult | undefined>;
  synthesize: (params: {
    cfg: OpenClawConfig;
    text: string;
  }) => Promise<{ success: boolean; audioPath?: string; error?: string }>;
};

async function withMattermostVoiceAudioFile<T>(
  samples: Int16Array,
  run: (filePath: string) => Promise<T>,
): Promise<T> {
  const workspace = await tempWorkspace({
    rootDir: resolvePreferredOpenClawTmpDir(),
    prefix: "mattermost-voice-",
  });
  try {
    const mono = downsampleStereo48kToMono16k(samples);
    const filePath = await workspace.write("segment.wav", buildMonoWav(mono, 16_000));
    return await run(filePath);
  } finally {
    await workspace.cleanup();
  }
}

function stripMattermostVoiceTtsMarkdown(text: string): string {
  return stripMarkdown(
    text
      .replace(/!\[([^\]]*)]\([^)]+\)/g, "$1")
      .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
      .replace(/^```[^\n]*\n?/gm, "")
      .replace(/^```\s*$/gm, ""),
  )
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*[•‣◦]\s+/gm, "")
    .replace(/^\s*\d+[.)]\s+/gm, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function containsOnlyLegacyAssistantFailureText(payloads: Array<{ text?: string }>): boolean {
  const texts = payloads
    .map((payload) => normalizeOptionalString(payload.text))
    .filter((text): text is string => Boolean(text));
  return (
    texts.length > 0 &&
    texts.every((text) =>
      text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .every((line) => line === ASSISTANT_TURN_FAILED_BEFORE_CONTENT),
    )
  );
}

function selectMattermostVoiceReplyText(result: AgentTurnResult | undefined): string {
  const payloads = result?.payloads ?? [];
  if (
    result?.meta?.error != null ||
    payloads.some((payload) => payload.isError === true) ||
    containsOnlyLegacyAssistantFailureText(payloads)
  ) {
    return MATTERMOST_VOICE_AGENT_ERROR_TEXT;
  }
  return payloads
    .map((payload) => normalizeOptionalString(payload.text))
    .filter((text): text is string => Boolean(text))
    .join("\n");
}

async function resolveMattermostVoiceAudioDurationMilliseconds(
  audioPath: string,
): Promise<number | undefined> {
  try {
    const pcm = await decodeAudioFileToStereo48k(audioPath);
    if (pcm.length === 0) {
      return undefined;
    }
    return Math.ceil((pcm.length / 4 / 48_000) * 1_000);
  } catch {
    return undefined;
  }
}

const defaultDependencies: VoiceTurnDependencies = {
  withAudioFile: withMattermostVoiceAudioFile,
  async transcribe({ agentId, cfg, filePath }) {
    const result = await getMattermostRuntime().mediaUnderstanding.transcribeAudioFile({
      filePath,
      cfg,
      agentDir: resolveAgentDir(cfg, agentId),
      mime: "audio/wav",
    });
    return normalizeOptionalString(result.text);
  },
  runAgent: agentCommandFromIngress,
  async synthesize({ cfg, text }) {
    return await getMattermostRuntime().tts.textToSpeech({
      text,
      cfg,
      channel: "mattermost",
    });
  },
};

export async function processMattermostVoiceTurn(
  params: {
    accountId: string;
    agentId: string;
    cfg: OpenClawConfig;
    channelId: string;
    runtime: RuntimeEnv;
    abortSignal?: AbortSignal;
    message?: string;
    samples: Int16Array;
    sessionKey: string;
    userId: string;
  },
  dependencies: VoiceTurnDependencies = defaultDependencies,
): Promise<MattermostVoiceReplyAudio | undefined> {
  const message = normalizeOptionalString(
    params.message ??
      (await transcribeMattermostVoiceTurn(
        {
          agentId: params.agentId,
          cfg: params.cfg,
          samples: params.samples,
        },
        dependencies,
      )),
  );
  if (!message) {
    return undefined;
  }

  return await generateMattermostVoiceReply(
    {
      accountId: params.accountId,
      agentId: params.agentId,
      abortSignal: params.abortSignal,
      cfg: params.cfg,
      channelId: params.channelId,
      message,
      runtime: params.runtime,
      sessionKey: params.sessionKey,
      userId: params.userId,
    },
    dependencies,
  );
}

export async function transcribeMattermostVoiceTurn(
  params: {
    agentId: string;
    cfg: OpenClawConfig;
    samples: Int16Array;
  },
  dependencies: Pick<VoiceTurnDependencies, "withAudioFile" | "transcribe"> = defaultDependencies,
): Promise<string | undefined> {
  return normalizeOptionalString(
    await dependencies.withAudioFile(
      params.samples,
      async (filePath) =>
        await dependencies.transcribe({
          agentId: params.agentId,
          cfg: params.cfg,
          filePath,
        }),
    ),
  );
}

export async function generateMattermostVoiceReply(
  params: {
    accountId: string;
    agentId: string;
    abortSignal?: AbortSignal;
    cfg: OpenClawConfig;
    channelId: string;
    message: string;
    runtime: RuntimeEnv;
    sessionKey: string;
    userId: string;
  },
  dependencies: Pick<VoiceTurnDependencies, "runAgent" | "synthesize"> = defaultDependencies,
): Promise<MattermostVoiceReplyAudio | undefined> {
  const message = normalizeOptionalString(params.message);
  if (!message) {
    return undefined;
  }
  if (params.abortSignal?.aborted) {
    return undefined;
  }
  let result: AgentTurnResult | undefined;
  try {
    result = await dependencies.runAgent(
      {
        accountId: params.accountId,
        agentId: params.agentId,
        allowModelOverride: false,
        abortSignal: params.abortSignal,
        deliver: false,
        disableMessageTool: true,
        extraSystemPrompt: MATTERMOST_VOICE_SYSTEM_PROMPT,
        message,
        messageChannel: "mattermost",
        messageProvider: "mattermost-voice",
        runContext: {
          accountId: params.accountId,
          chatId: params.channelId,
          currentChannelId: params.channelId,
          currentInboundAudio: true,
          messageChannel: "mattermost",
          senderId: params.userId,
        },
        sessionKey: params.sessionKey,
        transcriptMessage: message,
      },
      params.runtime,
    );
  } catch (error) {
    if (params.abortSignal?.aborted) {
      return undefined;
    }
    params.runtime.error?.(`mattermost voice agent turn failed: ${String(error)}`);
    result = { meta: { error } };
  }
  if (params.abortSignal?.aborted) {
    return undefined;
  }
  const replyText = selectMattermostVoiceReplyText(result);
  if (!replyText) {
    return undefined;
  }

  const spokenText = normalizeOptionalString(stripMattermostVoiceTtsMarkdown(replyText));
  if (!spokenText) {
    return undefined;
  }

  const speech = await dependencies.synthesize({ cfg: params.cfg, text: spokenText });
  if (!speech.success || !speech.audioPath) {
    throw new Error(`Mattermost voice TTS failed: ${speech.error ?? "no audio returned"}`);
  }
  const durationMilliseconds = await resolveMattermostVoiceAudioDurationMilliseconds(
    speech.audioPath,
  );
  return {
    audioPath: speech.audioPath,
    ...(durationMilliseconds === undefined ? {} : { durationMilliseconds }),
  };
}
