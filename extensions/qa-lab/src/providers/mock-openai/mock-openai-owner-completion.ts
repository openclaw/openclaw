import type { ResponsesInputItem, StreamEvent } from "./mock-openai-contracts.js";
import { buildAssistantEvents } from "./mock-openai-events.js";

const QA_OWNER_COMPLETION_START_RE = /Owner completion QA check: job=([a-z0-9-]+)/;
const QA_OWNER_COMPLETION_OUTPUT_RE = /QA-OWNER-COMPLETION-OUTPUT-([a-z0-9-]+)/;

function inputText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  return Array.isArray(content)
    ? content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("\n")
    : "";
}

/**
 * Scripts a channel turn that starts a background command, then the command's
 * completion turn, which asks the owner-only automations tool to create a
 * disabled job. The scenario asserts which requesters' completions persist it.
 */
export function planOwnerCompletionTurn(params: {
  input: ResponsesInputItem[];
  buildToolCall: (name: string, args: Record<string, unknown>) => StreamEvent[];
}): StreamEvent[] | null {
  // The latest start request and the latest completion event decide the step; a
  // completion newer than its start is the background command's continuation.
  const latest = (pattern: RegExp) => {
    for (let index = params.input.length - 1; index >= 0; index -= 1) {
      const item = params.input[index];
      const match = item?.role === "user" ? pattern.exec(inputText(item.content)) : null;
      if (match?.[1]) {
        return { index, job: match[1] };
      }
    }
    return undefined;
  };
  const answeredAfter = (index: number) =>
    params.input.slice(index + 1).some((item) => item.type === "function_call_output");
  const start = latest(QA_OWNER_COMPLETION_START_RE);
  const completion = latest(QA_OWNER_COMPLETION_OUTPUT_RE);
  if (completion && (!start || completion.index > start.index)) {
    return answeredAfter(completion.index)
      ? buildAssistantEvents("QA-OWNER-COMPLETION-DONE")
      : params.buildToolCall("automations", {
          action: "add",
          job: {
            name: `qa-owner-completion-${completion.job}`,
            enabled: false,
            schedule: { kind: "at", at: new Date(Date.now() + 86_400_000).toISOString() },
            sessionTarget: "isolated",
            payload: { kind: "agentTurn", message: "Owner completion QA job; never runs." },
            delivery: { mode: "none" },
          },
        });
  }
  if (!start) {
    return null;
  }
  return answeredAfter(start.index)
    ? buildAssistantEvents("QA-OWNER-COMPLETION-STARTED")
    : params.buildToolCall("exec", {
        command: `sleep 6; echo QA-OWNER-COMPLETION-OUTPUT-${start.job}`,
        background: true,
      });
}
