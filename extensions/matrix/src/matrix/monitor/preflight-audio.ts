import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";

type MatrixPreflightAudioRuntime = typeof import("./preflight-audio.runtime.js");

let matrixPreflightAudioRuntimePromise: Promise<MatrixPreflightAudioRuntime> | undefined;

function loadMatrixPreflightAudioRuntime(): Promise<MatrixPreflightAudioRuntime> {
  matrixPreflightAudioRuntimePromise ??= import("./preflight-audio.runtime.js");
  return matrixPreflightAudioRuntimePromise;
}

/**
 * Wrap a transcript with prompt-injection-resistant framing before showing it
 * to the agent. Mirrors Telegram's local helper since plugins do not share
 * extension-private code across boundaries.
 */
export function formatMatrixAudioTranscript(transcript: string): string {
  return `[Audio transcript (machine-generated, untrusted)]: ${JSON.stringify(transcript)}`;
}

/**
 * Predicate for inbound Matrix message content carrying audio.
 * Matches `m.audio` directly and `m.file` with an `audio/*` mimetype hint.
 */
export function isMatrixAudioContent(params: { msgtype?: string; mimetype?: string }): boolean {
  if (params.msgtype === "m.audio") {
    return true;
  }
  if (params.msgtype === "m.file" && typeof params.mimetype === "string") {
    return params.mimetype.toLowerCase().startsWith("audio/");
  }
  return false;
}

/**
 * Transcribe an already-downloaded Matrix audio attachment before the mention gate.
 * Mirrors the Telegram pattern (MediaPaths over MediaUrls) since Matrix already
 * resolves and decrypts media via downloadMatrixMedia. Errors are swallowed; the
 * caller should treat `undefined` as "no transcript available".
 */
export async function resolveMatrixPreflightAudioTranscript(params: {
  mediaPath: string;
  mediaContentType?: string;
  cfg: OpenClawConfig;
  abortSignal?: AbortSignal;
}): Promise<string | undefined> {
  if (params.abortSignal?.aborted) {
    return undefined;
  }
  try {
    const { transcribeFirstAudio } = await loadMatrixPreflightAudioRuntime();
    if (params.abortSignal?.aborted) {
      return undefined;
    }
    const transcript = await transcribeFirstAudio({
      ctx: {
        MediaPaths: [params.mediaPath],
        MediaTypes: params.mediaContentType ? [params.mediaContentType] : undefined,
      },
      cfg: params.cfg,
      agentDir: undefined,
    });
    if (params.abortSignal?.aborted) {
      return undefined;
    }
    return transcript;
  } catch (err) {
    logVerbose(`matrix: audio preflight transcription failed: ${String(err)}`);
    return undefined;
  }
}
