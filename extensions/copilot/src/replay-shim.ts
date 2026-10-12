import { asOptionalObjectRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

const MISSING_SESSION_CODES = new Set([
  "SESSION_NOT_FOUND",
  "session_not_found",
  "NotFound",
  "ENOENT",
]);

const MISSING_SESSION_MESSAGE_PATTERNS: readonly RegExp[] = [
  /\bsession not found\b/i,
  /\bsession .* not found\b/i,
  /\bunknown session id\b/i,
  /\bsession id .* (does not exist|not found)\b/i,
  /\bsession .* does not exist\b/i,
  /\bno such session\b/i,
];

// Only missing sessions permit recovery; auth and transport failures must surface.
export function isMissingCopilotSessionError(error: unknown): boolean {
  const record = asOptionalObjectRecord(error);
  if (record?.status === 404 || record?.statusCode === 404) {
    return true;
  }
  const code = record?.code;
  const message = record?.message;
  return (
    (typeof code === "string" && MISSING_SESSION_CODES.has(code)) ||
    (typeof message === "string" &&
      MISSING_SESSION_MESSAGE_PATTERNS.some((pattern) => pattern.test(message)))
  );
}

interface ReplayMetadataComputeInput {
  readonly priorReplayInvalid?: boolean;
  readonly priorHadPotentialSideEffects?: boolean;
  readonly thisAttemptTimedOut?: boolean;
  readonly thisAttemptHadPotentialSideEffects?: boolean;
  readonly thisAttemptDowngradedFromResume?: boolean;
  readonly thisAttemptResumeFailureRecovered?: boolean;
}

interface ComputedReplayMetadata {
  readonly hadPotentialSideEffects: boolean;
  readonly replaySafe: boolean;
}

// A timeout may have committed work server-side, so it is side-effecting even
// without an observed tool call. Replay carries the worst outcome across attempts.
export function computeReplayMetadata(input: ReplayMetadataComputeInput): ComputedReplayMetadata {
  const priorReplayInvalid = input.priorReplayInvalid === true;
  const priorHadPotentialSideEffects = input.priorHadPotentialSideEffects === true;
  const timedOut = input.thisAttemptTimedOut === true;
  const thisAttemptHadPotentialSideEffects = input.thisAttemptHadPotentialSideEffects === true;
  const downgraded = input.thisAttemptDowngradedFromResume === true;
  const recovered = input.thisAttemptResumeFailureRecovered === true;
  const hadPotentialSideEffects =
    priorHadPotentialSideEffects || timedOut || thisAttemptHadPotentialSideEffects;
  const replaySafe = !(priorReplayInvalid || downgraded || recovered || hadPotentialSideEffects);
  return { hadPotentialSideEffects, replaySafe };
}

const COPILOT_REPLAY_SAFE_READ_ONLY_TOOL_NAMES = new Set([
  "get",
  "file_read",
  "glob",
  "grep",
  "inspect",
  "list",
  "ls",
  "memory_get",
  "probe",
  "query",
  "read",
  "search",
  "sessions_history",
  "sessions_list",
  "status",
  "tool_search",
  "update_plan",
  "view",
  "web_fetch",
  "web_search",
]);

export function copilotToolMetasHavePotentialSideEffects(
  toolMetas?: readonly { asyncStarted?: boolean; toolName: string }[],
): boolean {
  return (toolMetas ?? []).some(
    (entry) =>
      entry.asyncStarted === true ||
      !COPILOT_REPLAY_SAFE_READ_ONLY_TOOL_NAMES.has(entry.toolName.trim().toLowerCase()),
  );
}
