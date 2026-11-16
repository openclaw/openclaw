import type { ResponsesInputItem, StreamEvent } from "./mock-openai-contracts.js";
import { buildAssistantEvents } from "./mock-openai-events.js";

const QA_CRON_ONE_SHOT_RE = /Cron one-shot QA mode=(yield|service|spawn)/;
const QA_CRON_ONE_SHOT_CHILD_MARKER = "Cron one-shot QA child";
const QA_CRON_ONE_SHOT_YIELD_OUTPUT = "QA-ONE-SHOT-YIELD-DONE";
const QA_CRON_ONE_SHOT_SERVICE_OUTPUT = "QA-ONE-SHOT-SERVICE-EXIT";
const QA_CRON_ONE_SHOT_CHILD_RESULT = "QA-ONE-SHOT-CHILD-RESULT";

function inputText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  return Array.isArray(content)
    ? content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("\n")
    : "";
}

/**
 * Scripts the one-shot cron run cases: a background command awaited with sessions_yield, a
 * background command left running past the run, and a spawned child whose result is the run's.
 */
export function planCronOneShotTurn(params: {
  prompt: string;
  input: ResponsesInputItem[];
  buildToolCall: (name: string, args: Record<string, unknown>) => StreamEvent[];
}): StreamEvent[] | null {
  if (params.prompt.includes(QA_CRON_ONE_SHOT_CHILD_MARKER)) {
    return buildAssistantEvents(QA_CRON_ONE_SHOT_CHILD_RESULT);
  }
  const start = params.input.findLastIndex(
    (item) => item.role === "user" && QA_CRON_ONE_SHOT_RE.test(inputText(item.content)),
  );
  const mode = QA_CRON_ONE_SHOT_RE.exec(inputText(params.input[start]?.content))?.[1];
  if (!mode) {
    return null;
  }
  if (mode === "yield" && params.prompt.includes(QA_CRON_ONE_SHOT_YIELD_OUTPUT)) {
    return buildAssistantEvents(`QA-ONE-SHOT-YIELD-OK ${QA_CRON_ONE_SHOT_YIELD_OUTPUT}`);
  }
  const completed = params.input
    .slice(start + 1)
    .filter((item) => item.type === "function_call_output").length;
  if (completed === 0) {
    return mode === "spawn"
      ? params.buildToolCall("sessions_spawn", {
          task: `Cron one-shot QA child: reply exactly ${QA_CRON_ONE_SHOT_CHILD_RESULT}.`,
          label: "qa-one-shot-child",
          mode: "run",
        })
      : params.buildToolCall("exec", {
          command:
            mode === "yield"
              ? `sleep 3; echo ${QA_CRON_ONE_SHOT_YIELD_OUTPUT}`
              : `sleep 30; echo ${QA_CRON_ONE_SHOT_SERVICE_OUTPUT}`,
          background: true,
        });
  }
  if (mode === "yield" && completed === 1) {
    return params.buildToolCall("sessions_yield", { message: "Waiting for the command." });
  }
  return buildAssistantEvents(mode === "service" ? "QA-ONE-SHOT-SERVICE-STARTED" : "NO_REPLY");
}
