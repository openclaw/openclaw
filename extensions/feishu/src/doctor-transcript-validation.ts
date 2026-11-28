import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

const BLANK_USER_MESSAGE_REPAIR_THRESHOLD = 3;

export type FeishuTranscriptFinding =
  | {
      kind: "invalid-session-transcript";
      sessionKey: string;
      storePath: string;
      path: string;
      reason: string;
    }
  | {
      kind: "blank-user-message-run";
      sessionKey: string;
      storePath: string;
      path: string;
      count: number;
    };

function isSessionHeader(value: unknown): boolean {
  return isRecord(value) && value.type === "session" && typeof value.id === "string";
}

function isBlankUserMessage(value: unknown): boolean {
  if (!isUserMessage(value)) {
    return false;
  }
  const content = value.message.content;
  if (typeof content === "string") {
    return content.trim().length === 0;
  }
  return Array.isArray(content) && content.length === 0;
}

function isUserMessage(value: unknown): value is { message: Record<string, unknown> } {
  return (
    isRecord(value) &&
    value.type === "message" &&
    isRecord(value.message) &&
    value.message.role === "user"
  );
}

export function invalidSessionTranscriptFinding(
  params: { sessionKey: string; storePath: string },
  transcriptPath: string,
  reason: string,
): FeishuTranscriptFinding {
  return {
    kind: "invalid-session-transcript",
    sessionKey: params.sessionKey,
    storePath: params.storePath,
    path: transcriptPath,
    reason,
  };
}

export function inspectTranscriptEntries(params: {
  sessionKey: string;
  storePath: string;
  transcriptPath: string;
  entries: unknown[];
  allowMissingSessionHeader?: boolean;
  malformedLines?: number;
}): FeishuTranscriptFinding | null {
  let blankUserMessageRun = 0;
  let maxBlankUserMessageRun = 0;
  for (const entry of params.entries) {
    if (isBlankUserMessage(entry)) {
      blankUserMessageRun += 1;
      maxBlankUserMessageRun = Math.max(maxBlankUserMessageRun, blankUserMessageRun);
    } else if (isUserMessage(entry)) {
      blankUserMessageRun = 0;
    }
  }

  if (params.entries.length === 0 && params.allowMissingSessionHeader) {
    return null;
  }
  const firstEntry = params.entries[0];
  const invalidReason =
    params.entries.length === 0
      ? "empty transcript"
      : !isSessionHeader(firstEntry) &&
          (!params.allowMissingSessionHeader || !isUserMessage(firstEntry))
        ? "invalid session header"
        : (params.malformedLines ?? 0) > 0
          ? `${params.malformedLines} malformed JSONL line(s)`
          : undefined;
  if (invalidReason) {
    return invalidSessionTranscriptFinding(params, params.transcriptPath, invalidReason);
  }
  if (maxBlankUserMessageRun >= BLANK_USER_MESSAGE_REPAIR_THRESHOLD) {
    return {
      kind: "blank-user-message-run",
      sessionKey: params.sessionKey,
      storePath: params.storePath,
      path: params.transcriptPath,
      count: maxBlankUserMessageRun,
    };
  }
  return null;
}
