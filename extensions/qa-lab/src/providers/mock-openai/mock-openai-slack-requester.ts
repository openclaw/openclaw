import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { ResponsesInputItem } from "./mock-openai-contracts.js";
import {
  extractSlackProgressCommentaryDirectives,
  hasToolDefinition,
  QA_SLACK_PROGRESS_COMMENTARY_MARKER_RE,
} from "./mock-openai-directives.js";
import { buildAssistantEvents } from "./mock-openai-events.js";
import {
  extractCurrentRuntimeContextTexts,
  extractLastMatchingUserTurn,
  extractToolOutput,
  hasToolOutput,
  parseToolOutputJson,
} from "./mock-openai-input.js";
import { buildScenarioToolCallEvents } from "./mock-openai-tool-routing.js";

export function readSlackProgressTurn(input: ResponsesInputItem[]) {
  const turn = extractLastMatchingUserTurn(input, QA_SLACK_PROGRESS_COMMENTARY_MARKER_RE);
  return {
    slackProgressDirectives: turn ? extractSlackProgressCommentaryDirectives(turn.text) : null,
    slackProgressInput: turn ? input.slice(turn.index) : [],
  };
}

export function buildSlackOwnedRequesterEvents(
  body: Record<string, unknown>,
  input: ResponsesInputItem[],
  currentPrompt: string,
) {
  const spawn = currentPrompt.includes("Slack agent-owned requester QA spawn.");
  const assign = currentPrompt.includes("Slack agent-owned requester QA assign.");
  if (!spawn && !assign) {
    return null;
  }
  if (hasToolOutput(input)) {
    return buildAssistantEvents(spawn ? "QA-SLACK-SPAWN-RESULT" : "QA-SLACK-ASSIGN-RESULT");
  }
  if (spawn) {
    return buildScenarioToolCallEvents(body, "sessions_spawn", {
      task: "Reply exactly: QA-SLACK-OWNED-CHILD-DONE",
      label: "Slack requester work",
      visible: true,
      context: "isolated",
    });
  }
  const conversation = extractCurrentRuntimeContextTexts(input)
    .flatMap((text) =>
      [...text.matchAll(/Conversation info:[^\n]*\n```json\n([\s\S]*?)\n```/gu)].map((match) =>
        asOptionalRecord(JSON.parse(match[1] ?? "{}")),
      ),
    )
    .find((value) => asOptionalRecord(value?.requester_profile));
  const requester = asOptionalRecord(conversation?.requester_profile);
  const spawned = input
    .filter((item) => item.type === "function_call_output")
    .map((item) => parseToolOutputJson(extractToolOutput([item])))
    .findLast((result) => typeof result?.childSessionKey === "string");
  if (
    typeof requester?.id !== "string" ||
    typeof spawned?.childSessionKey !== "string" ||
    !hasToolDefinition(body, "sessions")
  ) {
    return buildAssistantEvents("QA-SLACK-ASSIGN-MISSING-CONTEXT");
  }
  return buildScenarioToolCallEvents(body, "sessions", {
    action: "assign_owner",
    sessionKey: spawned.childSessionKey,
    ownerType: "human",
    ownerId: requester.id,
  });
}
