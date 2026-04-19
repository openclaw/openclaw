import { SessionManager } from "@mariozechner/pi-coding-agent";
import { emitSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import {
  buildToolResultSummaryText,
  buildToolSummaryText,
  isSubagentPersistToolFragmentsEnabled,
} from "./subagent-tool-redact.js";

export const TOOL_SUMMARY_KIND = "tool_summary" as const;
export const TOOL_RESULT_SUMMARY_KIND = "tool_result_summary" as const;

export type ToolFragmentKind = typeof TOOL_SUMMARY_KIND | typeof TOOL_RESULT_SUMMARY_KIND;

type AppendContext = {
  sessionFile?: string;
  sessionKey?: string;
};

type ToolUsePersistInput = AppendContext & {
  toolName: string;
  input?: unknown;
};

type ToolResultPersistInput = AppendContext & {
  toolName?: string;
  text?: string | null;
  isError?: boolean;
};

function appendAssistantToolFragment(params: {
  sessionFile: string;
  sessionKey?: string;
  kind: ToolFragmentKind;
  toolName?: string;
  text: string;
  isError?: boolean;
}): boolean {
  try {
    const sessionManager = SessionManager.open(params.sessionFile);
    const now = Date.now();
    const message = {
      role: "assistant",
      content: [{ type: "text", text: params.text }],
      timestamp: now,
      __openclaw: {
        kind: params.kind,
        ...(params.toolName ? { toolName: params.toolName } : {}),
        ...(params.isError ? { isError: true } : {}),
      },
    } as unknown as Parameters<typeof sessionManager.appendMessage>[0];
    sessionManager.appendMessage(message);
    emitSessionTranscriptUpdate({
      sessionFile: params.sessionFile,
      ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    });
    return true;
  } catch {
    // Persistence is best-effort: never fail the main run due to a
    // transcript write problem.
    return false;
  }
}

export function persistSubagentToolUse(params: ToolUsePersistInput): boolean {
  if (!isSubagentPersistToolFragmentsEnabled()) {
    return false;
  }
  const sessionFile = params.sessionFile?.trim();
  if (!sessionFile) {
    return false;
  }
  const text = buildToolSummaryText(params.toolName, params.input);
  return appendAssistantToolFragment({
    sessionFile,
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    kind: TOOL_SUMMARY_KIND,
    toolName: params.toolName,
    text,
  });
}

export function persistSubagentToolResult(params: ToolResultPersistInput): boolean {
  if (!isSubagentPersistToolFragmentsEnabled()) {
    return false;
  }
  const sessionFile = params.sessionFile?.trim();
  if (!sessionFile) {
    return false;
  }
  const text = buildToolResultSummaryText(params.text);
  return appendAssistantToolFragment({
    sessionFile,
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    kind: TOOL_RESULT_SUMMARY_KIND,
    ...(params.toolName ? { toolName: params.toolName } : {}),
    text,
    ...(params.isError ? { isError: true } : {}),
  });
}

export function isPersistedSubagentToolFragment(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  const meta = (message as { __openclaw?: unknown }).__openclaw;
  if (!meta || typeof meta !== "object") {
    return false;
  }
  const kind = (meta as { kind?: unknown }).kind;
  return kind === TOOL_SUMMARY_KIND || kind === TOOL_RESULT_SUMMARY_KIND;
}
