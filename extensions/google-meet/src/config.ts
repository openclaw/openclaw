import {
  buildMeetingConfigAudioCommands,
  resolveMeetingChromeConfig,
  resolveMeetingRealtimeConfig,
} from "openclaw/plugin-sdk/meeting-config";
import {
  addTimerTimeoutGraceMs,
  resolvePositiveTimerTimeoutMs,
} from "openclaw/plugin-sdk/number-runtime";
import { REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME } from "openclaw/plugin-sdk/realtime-voice";
import {
  asBoolean,
  asRecord,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
  normalizeOptionalTrimmedStringList,
  parseBooleanValue,
} from "openclaw/plugin-sdk/string-coerce-runtime";

export type GoogleMeetTransport = "chrome" | "chrome-node" | "twilio";
export type GoogleMeetMode = "agent" | "bidi" | "transcribe";
export type GoogleMeetModeInput = GoogleMeetMode | "realtime";
type GoogleMeetChromeAudioFormat = "pcm16-24khz" | "g711-ulaw-8khz";

type DeepOptionalUndefined<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? {
        [K in keyof T as undefined extends T[K] ? K : never]?: DeepOptionalUndefined<T[K]>;
      } & {
        [K in keyof T as undefined extends T[K] ? never : K]: DeepOptionalUndefined<T[K]>;
      }
    : T;

export type GoogleMeetConfig = DeepOptionalUndefined<ReturnType<typeof resolveGoogleMeetConfig>>;

export function resolveGoogleMeetGatewayOperationTimeoutMs(config: GoogleMeetConfig): number {
  return Math.max(
    60_000,
    addTimerTimeoutGraceMs(config.chrome.joinTimeoutMs, 30_000) ?? 1,
    addTimerTimeoutGraceMs(config.voiceCall.requestTimeoutMs, 10_000) ?? 1,
  );
}

const SOX_DEFAULT_BUFFER_BYTES = 8192;
const DEFAULT_GOOGLE_MEET_AUDIO_BUFFER_BYTES = SOX_DEFAULT_BUFFER_BYTES / 2;
const PLAIN_DECIMAL_NUMBER_RE = /^\d+(?:\.\d+)?$/;

const DEFAULT_GOOGLE_MEET_AUDIO_COMMANDS = buildMeetingConfigAudioCommands(
  "blackhole-2ch",
  "pcm16-24khz",
  DEFAULT_GOOGLE_MEET_AUDIO_BUFFER_BYTES,
);

export const DEFAULT_GOOGLE_MEET_AUDIO_INPUT_COMMAND =
  DEFAULT_GOOGLE_MEET_AUDIO_COMMANDS.inputCommand;
export const DEFAULT_GOOGLE_MEET_AUDIO_OUTPUT_COMMAND =
  DEFAULT_GOOGLE_MEET_AUDIO_COMMANDS.outputCommand;

const DEFAULT_GOOGLE_MEET_REALTIME_INSTRUCTIONS = `You are joining a private Google Meet as an OpenClaw voice transport. Keep spoken replies brief and natural. In agent mode, wait for OpenClaw consult results and speak them exactly. In bidi mode, answer directly and call ${REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME} for deeper reasoning, current information, or tools.`;

function resolveOptionalNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const trimmed = value.trim();
    const parsed = PLAIN_DECIMAL_NUMBER_RE.test(trimmed) ? Number(trimmed) : Number.NaN;
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function readGoogleMeetEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return (
    normalizeOptionalString(env[name]) ??
    normalizeOptionalString(env[name.slice("OPENCLAW_".length)])
  );
}

function resolveTransport(value: unknown, fallback: GoogleMeetTransport): GoogleMeetTransport {
  const normalized = normalizeOptionalLowercaseString(value);
  return normalized === "chrome" || normalized === "chrome-node" || normalized === "twilio"
    ? normalized
    : fallback;
}

function resolveMode(value: unknown, fallback: GoogleMeetMode): GoogleMeetMode {
  const normalized = normalizeOptionalLowercaseString(value);
  if (normalized === "realtime") {
    return "agent";
  }
  return normalized === "agent" || normalized === "bidi" || normalized === "transcribe"
    ? normalized
    : fallback;
}

function resolveChromeAudioFormat(value: unknown): GoogleMeetChromeAudioFormat | undefined {
  const normalized = normalizeOptionalString(value)?.toLowerCase().replaceAll("_", "-");
  switch (normalized) {
    case "pcm16-24khz":
    case "pcm16-24k":
    case "pcm24":
    case "pcm":
      return "pcm16-24khz";
    case "g711-ulaw-8khz":
    case "g711-ulaw-8k":
    case "g711-ulaw":
    case "mulaw":
    case "mu-law":
      return "g711-ulaw-8khz";
    default:
      return undefined;
  }
}

export function resolveGoogleMeetConfig(input: unknown) {
  const env = process.env;
  const raw = asRecord(input);
  const defaults = asRecord(raw.defaults);
  const preview = asRecord(raw.preview);
  const chrome = asRecord(raw.chrome);
  const chromeNode = asRecord(raw.chromeNode);
  const twilio = asRecord(raw.twilio);
  const voiceCall = asRecord(raw.voiceCall);
  const realtime = asRecord(raw.realtime);
  const realtimeProvider = normalizeOptionalString(realtime.provider);
  const oauth = asRecord(raw.oauth);
  const auth = asRecord(raw.auth);

  return {
    enabled: asBoolean(raw.enabled) ?? true,
    defaults: {
      meeting:
        normalizeOptionalString(defaults.meeting) ??
        readGoogleMeetEnv(env, "OPENCLAW_GOOGLE_MEET_DEFAULT_MEETING"),
    },
    preview: {
      enrollmentAcknowledged:
        asBoolean(preview.enrollmentAcknowledged) ??
        parseBooleanValue(readGoogleMeetEnv(env, "OPENCLAW_GOOGLE_MEET_PREVIEW_ACK")) ??
        false,
    },
    defaultTransport: resolveTransport(raw.defaultTransport, "chrome"),
    defaultMode: resolveMode(raw.defaultMode, "agent"),
    chrome: {
      ...resolveMeetingChromeConfig(chrome, {
        resolveAudioFormat: (hasCustomCommands) =>
          resolveChromeAudioFormat(chrome.audioFormat) ??
          (hasCustomCommands ? "g711-ulaw-8khz" : "pcm16-24khz"),
        waitForInCallMs: 20_000,
      }),
      audioBridgeCommand: normalizeOptionalTrimmedStringList(chrome.audioBridgeCommand),
      audioBridgeHealthCommand: normalizeOptionalTrimmedStringList(chrome.audioBridgeHealthCommand),
    },
    chromeNode: {
      node: normalizeOptionalString(chromeNode.node),
    },
    twilio: {
      defaultDialInNumber: normalizeOptionalString(twilio.defaultDialInNumber),
      defaultPin: normalizeOptionalString(twilio.defaultPin),
      defaultDtmfSequence: normalizeOptionalString(twilio.defaultDtmfSequence),
    },
    voiceCall: {
      enabled: asBoolean(voiceCall.enabled) ?? true,
      gatewayUrl: normalizeOptionalString(voiceCall.gatewayUrl),
      token: normalizeOptionalString(voiceCall.token),
      requestTimeoutMs: resolvePositiveTimerTimeoutMs(voiceCall.requestTimeoutMs, 30_000),
      dtmfDelayMs: resolvePositiveTimerTimeoutMs(voiceCall.dtmfDelayMs, 12_000),
      postDtmfSpeechDelayMs: resolvePositiveTimerTimeoutMs(voiceCall.postDtmfSpeechDelayMs, 5_000),
      introMessage: normalizeOptionalString(voiceCall.introMessage),
    },
    realtime: resolveMeetingRealtimeConfig(realtime, {
      instructions: DEFAULT_GOOGLE_MEET_REALTIME_INSTRUCTIONS,
      transcriptionProvider:
        realtimeProvider && realtimeProvider !== "google" ? realtimeProvider : "openai",
    }),
    oauth: {
      clientId:
        normalizeOptionalString(oauth.clientId) ??
        normalizeOptionalString(auth.clientId) ??
        readGoogleMeetEnv(env, "OPENCLAW_GOOGLE_MEET_CLIENT_ID"),
      clientSecret:
        normalizeOptionalString(oauth.clientSecret) ??
        normalizeOptionalString(auth.clientSecret) ??
        readGoogleMeetEnv(env, "OPENCLAW_GOOGLE_MEET_CLIENT_SECRET"),
      refreshToken:
        normalizeOptionalString(oauth.refreshToken) ??
        readGoogleMeetEnv(env, "OPENCLAW_GOOGLE_MEET_REFRESH_TOKEN"),
      accessToken:
        normalizeOptionalString(oauth.accessToken) ??
        readGoogleMeetEnv(env, "OPENCLAW_GOOGLE_MEET_ACCESS_TOKEN"),
      expiresAt:
        resolveOptionalNumber(oauth.expiresAt) ??
        resolveOptionalNumber(
          readGoogleMeetEnv(env, "OPENCLAW_GOOGLE_MEET_ACCESS_TOKEN_EXPIRES_AT"),
        ),
    },
    auth: {
      provider: "google-oauth" as const,
      clientId: normalizeOptionalString(auth.clientId),
      clientSecret: normalizeOptionalString(auth.clientSecret),
      tokenPath: normalizeOptionalString(auth.tokenPath),
    },
  };
}
