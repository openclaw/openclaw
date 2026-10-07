import type { SessionTranscriptContextVersion } from "openclaw/plugin-sdk/codex-session-transcript-runtime";
import type { TranscriptTurnAdmission } from "openclaw/plugin-sdk/session-transcript-runtime";
import { serveWorkerTasks } from "openclaw/plugin-sdk/worker-task-server";
import type { CodexHistoryReadResult } from "./src/app-server/history-rejection.js";
import type { JsonValue } from "./src/app-server/protocol.js";
import {
  readCodexNativeHistory,
  type ResolvedCodexHistoryTarget,
} from "./src/app-server/session-history-read.js";
import {
  projectVerifiedSettledCodexMessages,
  type SettledTurnMessages,
} from "./src/app-server/settled-turn-evidence.js";

export type CodexHistoryWorkerInput = {
  target: ResolvedCodexHistoryTarget;
  sessionId: string;
  admission?: TranscriptTurnAdmission;
  evidence: SettledTurnMessages;
};
export type CodexHistoryWorkerResult = {
  result: CodexHistoryReadResult<JsonValue[]>;
  version?: SessionTranscriptContextVersion;
};

export async function runCodexHistoryWorkerInput(
  input: unknown,
): Promise<CodexHistoryWorkerResult> {
  // SAFETY: The paired runtime constructs this request; the SQLite snapshot validates admission.
  const request = input as CodexHistoryWorkerInput;
  let version: SessionTranscriptContextVersion | undefined;
  const onSnapshot = (value: SessionTranscriptContextVersion | undefined) => {
    version = value;
  };
  const result = await readCodexNativeHistory(
    request.target,
    request.sessionId,
    (messages) => projectVerifiedSettledCodexMessages(messages, request.evidence),
    request.admission,
    onSnapshot,
  );
  return { result, version };
}

serveWorkerTasks(runCodexHistoryWorkerInput);
