import type { MockProviderVariant } from "../shared/mock-provider-variant.js";
import {
  type MockScenarioState,
  type ResponsesInputItem,
  type StreamEvent,
  subagentFanoutTaskForProvider,
} from "./mock-openai-contracts.js";
import { buildAssistantEvents } from "./mock-openai-events.js";
import { extractAllRequestTexts, isMockSubagentSettledWake } from "./mock-openai-input.js";
import { buildScenarioToolCallEvents, canCallScenarioTool } from "./mock-openai-tool-routing.js";

export function planSubagentFanoutTurn(params: {
  input: ResponsesInputItem[];
  body: Record<string, unknown>;
  toolDeclarationBody: Record<string, unknown>;
  currentPrompt: string;
  allInputText: string;
  hasCompletedToolOutput: boolean;
  providerVariant: MockProviderVariant;
  scenarioState: MockScenarioState;
}): StreamEvent[] | null {
  const {
    input,
    body,
    toolDeclarationBody,
    currentPrompt,
    allInputText,
    hasCompletedToolOutput,
    providerVariant,
    scenarioState,
  } = params;
  const canCallSessionsSpawn = canCallScenarioTool(toolDeclarationBody, "sessions_spawn");
  const canCallSessionsYield = canCallScenarioTool(toolDeclarationBody, "sessions_yield");
  const canCallMessage = canCallScenarioTool(toolDeclarationBody, "message", true);
  const buildToolCallEventsWithArgs = (name: string, args: Record<string, unknown>) =>
    buildScenarioToolCallEvents(toolDeclarationBody, name, args);
  const isSubagentFanoutPrompt = /subagent fanout synthesis check/i.test(allInputText);
  const currentFanoutInstructions = extractAllRequestTexts(
    input.filter((item) => item.role === "system" || item.role === "developer"),
    body,
  );
  const fanoutRequiresFinalMessage =
    /visible source replies are not automatically delivered for this run\.\s*use `?message\(action=send\)`?[\s\S]*set `?final=true`?/i.test(
      currentFanoutInstructions,
    );
  // Delivery mode belongs to this turn's instructions, not earlier transcript
  // turns whose private-reply policy may no longer apply.
  const fanoutHasPrivateSourceReply =
    isSubagentFanoutPrompt &&
    (fanoutRequiresFinalMessage ||
      /visible reply must use `?message\(action=send\)`?;\s*final text is private/i.test(
        currentFanoutInstructions,
      ));
  const fanoutRequiresMessageTool = fanoutHasPrivateSourceReply && canCallMessage;
  if (
    scenarioState.subagentFanoutPhase === 3 &&
    fanoutRequiresMessageTool &&
    hasCompletedToolOutput
  ) {
    return buildAssistantEvents("");
  }
  const completeSubagentFanout = () => {
    scenarioState.subagentFanoutPhase = 3;
    const message = "subagent-1: ok\nsubagent-2: ok";
    return fanoutRequiresMessageTool
      ? buildToolCallEventsWithArgs("message", {
          action: "send",
          message,
          ...(fanoutRequiresFinalMessage ? { final: true } : {}),
        })
      : buildAssistantEvents(message);
  };
  if (
    !hasCompletedToolOutput &&
    /subagent fanout synthesis check/i.test(currentPrompt) &&
    scenarioState.subagentFanoutPhase !== 0
  ) {
    scenarioState.subagentFanoutPhase = 0;
    scenarioState.subagentFanoutCompletedWorkers.clear();
  }
  // A requester can resume in a fresh native session. Its current all-settled
  // envelope carries both results independently of this session's local phase.
  if (
    isSubagentFanoutPrompt &&
    scenarioState.subagentFanoutPhase === 0 &&
    isMockSubagentSettledWake(currentPrompt) &&
    /\bALPHA-OK\b/i.test(currentPrompt) &&
    /\bBETA-OK\b/i.test(currentPrompt)
  ) {
    scenarioState.subagentFanoutPhase = 2;
  }
  // A later requester-settle wake must replay the completed synthesis without spawning again.
  if (isSubagentFanoutPrompt && scenarioState.subagentFanoutPhase === 3) {
    return buildAssistantEvents("subagent-1: ok\nsubagent-2: ok");
  }
  if (canCallSessionsSpawn && isSubagentFanoutPrompt) {
    if (!hasCompletedToolOutput && scenarioState.subagentFanoutPhase === 0) {
      scenarioState.subagentFanoutPhase = 1;
      return buildToolCallEventsWithArgs("sessions_spawn", {
        task: subagentFanoutTaskForProvider(providerVariant, "alpha"),
        label: "qa-fanout-alpha",
        thread: false,
      });
    }
    if (hasCompletedToolOutput && scenarioState.subagentFanoutPhase === 1) {
      scenarioState.subagentFanoutPhase = 2;
      return buildToolCallEventsWithArgs("sessions_spawn", {
        task: subagentFanoutTaskForProvider(providerVariant, "beta"),
        label: "qa-fanout-beta",
        thread: false,
      });
    }
  }
  if (scenarioState.subagentFanoutPhase === 2) {
    if (/\bALPHA-OK\b/i.test(allInputText)) {
      scenarioState.subagentFanoutCompletedWorkers.add("alpha");
    }
    if (/\bBETA-OK\b/i.test(allInputText)) {
      scenarioState.subagentFanoutCompletedWorkers.add("beta");
    }
    // A frozen child envelope may deny message. Its private final cannot be
    // published; keep the batch for the requester-owned all-settled wake.
    if (fanoutHasPrivateSourceReply && !fanoutRequiresMessageTool) {
      return buildAssistantEvents("");
    }
    if (scenarioState.subagentFanoutCompletedWorkers.size === 2) {
      return completeSubagentFanout();
    }
    if (canCallSessionsYield) {
      return buildToolCallEventsWithArgs("sessions_yield", {
        message: "Waiting for both QA fanout workers to finish.",
      });
    }
    if (fanoutRequiresMessageTool) {
      // Restricted completion turns cannot yield; stay silent until both
      // workers settle instead of advancing past the sole visible reply.
      return buildAssistantEvents("");
    }
    if (hasCompletedToolOutput) {
      return completeSubagentFanout();
    }
  }
  return null;
}
