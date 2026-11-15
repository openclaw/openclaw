import type { ResponsesInputItem, StreamEvent } from "./mock-openai-contracts.js";
import { buildAssistantEvents } from "./mock-openai-events.js";

const QA_CRON_TRUSTED_OWNER_PROMPT_RE =
  /Trusted automation owner QA check: action=(pause|narrow|realert|dormant|redeclare) target=(\S+) marker=(\S+)/;

/**
 * Scripts a chat turn that pauses an operator-created automation rewrites its prompt and
 * tools, moves its failure alerts, turns it into a
 * system event, or redeclares its key, then ends with the marker. The scenario asserts the stored job.
 */
export function planCronTrustedOwnerTurn(params: {
  prompt: string;
  input: ResponsesInputItem[];
  buildToolCall: (name: string, args: Record<string, unknown>) => StreamEvent[];
}): StreamEvent[] | null {
  const match = QA_CRON_TRUSTED_OWNER_PROMPT_RE.exec(params.prompt);
  if (!match) {
    return null;
  }
  const [, action, jobId, marker] = match;
  // Earlier pauses stay in this conversation's history; only this turn's result counts.
  const lastUser = params.input.findLastIndex((item) => item.role === "user");
  if (!params.input.slice(lastUser + 1).some((item) => item.type === "function_call_output")) {
    if (action === "redeclare") {
      // jobId carries the declaration key for this action.
      return params.buildToolCall("automations", {
        action: "add",
        job: {
          name: "Owner redeclaration",
          declarationKey: jobId,
          schedule: { kind: "every", everyMs: 3_600_000 },
          sessionTarget: "main",
          payload: { kind: "systemEvent", text: "Replaced by the owner conversation." },
        },
      });
    }
    return params.buildToolCall("automations", {
      action: "update",
      jobId,
      job:
        action === "pause"
          ? { enabled: false }
          : action === "realert"
            ? { failureAlert: { after: 1, mode: "webhook", to: "https://alerts.example/cron" } }
            : action === "dormant"
              ? { sessionTarget: "main", payload: { kind: "systemEvent", text: "Check status" } }
              : {
                  payload: {
                    kind: "agentTurn",
                    message: "Narrowed by the owner conversation.",
                    toolsAllow: [],
                  },
                },
    });
  }
  return buildAssistantEvents(marker ?? "");
}
