import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { ResponsesInputItem, StreamEvent } from "./mock-openai-contracts.js";
import { readFirstMediaPath } from "./mock-openai-directives.js";
import { buildAssistantEvents } from "./mock-openai-events.js";
import {
  extractAllToolOutputText,
  extractLastMatchingUserTurn,
  parseToolOutputJson,
  splitMockConversationContext,
} from "./mock-openai-input.js";
import { canCallScenarioTool, readScenarioToolCompletion } from "./mock-openai-tool-routing.js";

// One line of JSON after the marker: `QA tool plan: {"calls":[{"name":"<tool>","args":{}}],
// "reply":"..."}`. The model calls each tool in order with exactly those arguments, then replies;
// `{{media:N}}` in the reply becomes the first media path the Nth call's result carried, so a
// scenario can name runtime paths without putting them in the user's own text.
const QA_TOOL_PLAN_PROMPT_RE = /\bQA tool plan:\s*(\{[^\n]*\})/u;

type QaToolPlan = { calls: { name: string; args: Record<string, unknown> }[]; reply: string };

function parseQaToolPlan(prompt: string): QaToolPlan | null {
  const json = QA_TOOL_PLAN_PROMPT_RE.exec(prompt)?.[1];
  if (!json) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  const plan = asOptionalRecord(value);
  const calls = Array.isArray(plan?.calls) ? plan.calls.map((call) => asOptionalRecord(call)) : [];
  if (typeof plan?.reply !== "string" || calls.length === 0) {
    return null;
  }
  const parsed: QaToolPlan["calls"] = [];
  for (const call of calls) {
    if (typeof call?.name !== "string" || !call.name) {
      return null;
    }
    parsed.push({ name: call.name, args: asOptionalRecord(call.args) ?? {} });
  }
  return { calls: parsed, reply: plan.reply };
}

function readOutputMediaPath(output: string): string {
  const json = parseToolOutputJson(output);
  // A call routed through the Tool Search dispatcher returns `{ tool, result }`.
  const result = asOptionalRecord(json?.result) ?? json;
  const structured = readFirstMediaPath(asOptionalRecord(result?.details)?.media ?? result?.media);
  return (
    structured ||
    /MEDIA:\s*(\S+)/u.exec(output)?.[1] ||
    // A plain-text result names a POSIX or drive-rooted Windows path.
    /(?:^|\s)((?:\/|[A-Za-z]:[\\/])[^\s"'`<>]+)/u.exec(output)?.[1] ||
    ""
  );
}

/** Scripts a turn from a `QA tool plan:` directive in the current request, or returns null. */
export function planQaToolPlanTurn(
  prompt: string,
  input: ResponsesInputItem[],
  toolDeclarationBody: Record<string, unknown>,
  callTool: (name: string, args: Record<string, unknown>) => StreamEvent[],
): StreamEvent[] | null {
  // Quoted history must not start a plan; only the current request can.
  const plan = parseQaToolPlan(splitMockConversationContext(prompt).current);
  if (!plan) {
    return null;
  }
  // Only results after this plan's own user turn count; earlier turns ran other plans.
  const turn = extractLastMatchingUserTurn(input, QA_TOOL_PLAN_PROMPT_RE);
  const toolOutputs = input.flatMap((item, index) =>
    index >= (turn?.index ?? input.length) &&
    (item.type === "function_call_output" || item.type === "custom_tool_call_output")
      ? [{ item, index }]
      : [],
  );
  const outputs: string[] = [];
  for (const { item, index } of toolOutputs) {
    // A call that Code Mode runs reports `waiting` until a `wait` settles it; only its settled
    // result counts as the call's. While the latest is waiting, the server's Code Mode
    // handling issues the `wait`.
    const completion = readScenarioToolCompletion(
      toolDeclarationBody,
      input.slice(0, index + 1),
      "",
    );
    if (!completion.hasCodeModeControlOutput) {
      outputs.push(extractAllToolOutputText([item]));
    } else if (completion.codeModeControlJson?.status !== "waiting") {
      outputs.push(completion.toolOutput);
    } else if (index === toolOutputs.at(-1)?.index) {
      return null;
    }
  }
  const next = plan.calls[outputs.length];
  if (next) {
    return canCallScenarioTool(toolDeclarationBody, next.name)
      ? callTool(next.name, next.args)
      : buildAssistantEvents(`BUG-QA-TOOL-PLAN-UNDECLARED ${next.name}`);
  }
  return buildAssistantEvents(
    plan.reply.replace(
      /\{\{media:(\d+)\}\}/gu,
      (_match, index: string) =>
        readOutputMediaPath(outputs[Number(index)] ?? "") || `BUG-QA-TOOL-PLAN-NO-MEDIA-${index}`,
    ),
  );
}
