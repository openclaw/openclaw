import { isRecord } from "../../../packages/normalization-core/src/record-coerce.ts";

export type MockInferenceFacts = {
  purpose: "activity-recap" | "session-observer" | "benchmark-turn" | "other";
  benchmarkPhase?: "warmup" | "load";
  turnIndex?: number;
  hasToolOutput: boolean;
  hasPreviousResponse: boolean;
  inputItems: number;
};

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
      const text = contentText(item.content);
      // Responses projects the runtime-context carrier as a user message after
      // its owner. Skip only that complete wrapper, never a later ordinary user.
      if (
        text.startsWith("<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\n") &&
        text.endsWith("\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>")
      ) {
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
