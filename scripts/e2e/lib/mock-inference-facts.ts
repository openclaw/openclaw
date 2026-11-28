import {
  hasLegacyRuntimeContextEnvelope,
  RUNTIME_CONTEXT_FOOTER,
  RUNTIME_CONTEXT_HEADER,
} from "../../../packages/llm-core/src/types.ts";
import { isRecord } from "../../../packages/normalization-core/src/record-coerce.ts";

export type MockInferenceFacts = {
  purpose: "activity-recap" | "session-observer" | "benchmark-turn" | "other";
  benchmarkPhase?: "warmup" | "load";
  turnIndex?: number;
  hasToolOutput: boolean;
  hasPreviousResponse: boolean;
  inputItems: number;
};

/** Opt-in native diagnostics ledger: fixed routes and synthetic correlation, never request bodies. */
export function createMockNativeChatAccounting() {
  const ordinals = { responses: 0, embeddings: 0, chatCompletions: 0, other: 0 };
  type Route = keyof typeof ordinals;
  const entries: Array<{
    route: Route;
    ordinal: number;
    pid?: number;
    runId?: string;
    callId?: string;
  }> = [];
  let dropped = 0;
  return {
    record(route: Route, headers: Record<string, string | string[] | undefined>) {
      const ordinal = ++ordinals[route];
      if (entries.length >= 1000) {
        dropped++;
        return;
      }
      const pid = headers["x-openclaw-perf-pid"];
      const runId = headers["x-openclaw-perf-run"];
      const callId = headers["x-openclaw-perf-call"];
      const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu;
      const correlated =
        typeof pid === "string" &&
        /^[1-9]\d{0,8}$/u.test(pid) &&
        typeof runId === "string" &&
        uuid.test(runId) &&
        typeof callId === "string" &&
        (uuid.test(callId) ||
          (callId.startsWith(`${runId}:model:`) &&
            /^[1-9]\d*$/u.test(callId.slice(runId.length + 7))));
      entries.push({
        route,
        ordinal,
        ...(correlated ? { pid: Number(pid), runId, callId } : {}),
      });
    },
    snapshot() {
      return { version: 1, dropped, entries: entries.map((entry) => Object.assign({}, entry)) };
    },
  };
}

function contentText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  return Array.isArray(content)
    ? content
        .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
        .join("\n")
    : "";
}

export function readMockUserText(message: unknown): string | undefined {
  if (!isRecord(message) || message.role !== "user") {
    return undefined;
  }
  const text = contentText(message.content);
  // Provider projections can place runtime context after the current turn's tool output.
  return hasLegacyRuntimeContextEnvelope(text) ||
    (text.startsWith(`${RUNTIME_CONTEXT_HEADER}\n`) && text.endsWith(`\n${RUNTIME_CONTEXT_FOOTER}`))
    ? undefined
    : text;
}

/** Keep bounded purpose facts before the mock clips request bodies; never retain prompt excerpts. */
export function summarizeMockInferenceRequest(body: unknown): MockInferenceFacts {
  const request = isRecord(body) ? body : {};
  const input = request.input ?? request.messages;
  const messages = Array.isArray(input) ? input : [];
  const system = [
    contentText(request.instructions),
    ...messages.flatMap((item) =>
      isRecord(item) && (item.role === "system" || item.role === "developer")
        ? [contentText(item.content)]
        : [],
    ),
  ];
  // These are the owning Activity recap and session-observer prompt fingerprints.
  // Check them before markers: utility inputs can quote a benchmark user's text.
  let purpose: MockInferenceFacts["purpose"] = system.some((text) =>
    text.startsWith("Write an Activity recap for someone scanning their tasks:"),
  )
    ? "activity-recap"
    : system.some((text) =>
          text.startsWith("You judge the trajectory of a running AI agent session"),
        )
      ? "session-observer"
      : "other";
  let marker: RegExpMatchArray | null = null;
  let hasToolOutput = false;
  for (const item of messages.toReversed()) {
    if (!isRecord(item)) {
      continue;
    }
    if (item.role === "user") {
      const text = readMockUserText(item);
      if (text === undefined) {
        continue;
      }
      marker = text.match(/benchmark (?:(warmup) )?(?:tool )?stream (\d+)\./u);
      break;
    }
    hasToolOutput ||= item.role === "tool" || item.type === "function_call_output";
  }
  if (purpose === "other" && marker) {
    purpose = "benchmark-turn";
  }
  return {
    purpose,
    ...(purpose === "benchmark-turn" && marker
      ? {
          benchmarkPhase: marker[1] ? ("warmup" as const) : ("load" as const),
          turnIndex: Number(marker[2]),
        }
      : {}),
    hasToolOutput,
    hasPreviousResponse:
      typeof request.previous_response_id === "string" && request.previous_response_id.length > 0,
    inputItems: messages.length,
  };
}
