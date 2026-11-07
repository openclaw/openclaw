import type { ResponsesInputItem, StreamEvent } from "./mock-openai-contracts.js";
import { buildAssistantEvents } from "./mock-openai-events.js";

type PlanParams = {
  input: ResponsesInputItem[];
  buildToolCall: (name: string, args: Record<string, unknown>) => StreamEvent[];
};

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
 * completion turn, which makes one more tool call. The scenario asserts which
 * requesters' completions get that call's effect.
 */
function planBackgroundCompletionTurn(
  params: PlanParams,
  script: {
    prefix: string;
    start: RegExp;
    launch: (job: string) => string;
    completionCall: (job: string) => [name: string, args: Record<string, unknown>];
  },
): StreamEvent[] | null {
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
  const start = latest(script.start);
  const completion = latest(new RegExp(`${script.prefix}-OUTPUT-([a-z0-9-]+)`));
  if (completion && (!start || completion.index > start.index)) {
    return answeredAfter(completion.index)
      ? buildAssistantEvents(`${script.prefix}-DONE`)
      : params.buildToolCall(...script.completionCall(completion.job));
  }
  if (!start) {
    return null;
  }
  return answeredAfter(start.index)
    ? buildAssistantEvents(`${script.prefix}-STARTED`)
    : params.buildToolCall("exec", {
        command: `${script.launch(start.job)}; echo ${script.prefix}-OUTPUT-${start.job}`,
        background: true,
      });
}

/** The completion asks the owner-only automations tool to create a disabled job. */
export function planOwnerCompletionTurn(params: PlanParams): StreamEvent[] | null {
  return planBackgroundCompletionTurn(params, {
    prefix: "QA-OWNER-COMPLETION",
    start: /Owner completion QA check: job=([a-z0-9-]+)/,
    launch: () => "sleep 6",
    completionCall: (job) => [
      "automations",
      {
        action: "add",
        job: {
          name: `qa-owner-completion-${job}`,
          enabled: false,
          schedule: { kind: "at", at: new Date(Date.now() + 86_400_000).toISOString() },
          sessionTarget: "isolated",
          payload: { kind: "agentTurn", message: "Owner completion QA job; never runs." },
          delivery: { mode: "none" },
        },
      },
    ],
  });
}

/** The completion runs exec again; each command writes a marker that proves it ran. */
export function planRequesterCompletionTurn(params: PlanParams): StreamEvent[] | null {
  return planBackgroundCompletionTurn(params, {
    prefix: "QA-REQUESTER-COMPLETION",
    start: /Requester completion QA check: job=([a-z0-9-]+)/,
    launch: (job) => `printf launched > qa-requester-launch-${job}.txt; sleep 10`,
    completionCall: (job) => [
      "exec",
      { command: `printf ran > qa-requester-completion-${job}.txt` },
    ],
  });
}
