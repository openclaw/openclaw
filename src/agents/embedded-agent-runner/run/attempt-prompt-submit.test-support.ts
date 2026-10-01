import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { vi } from "vitest";
import type { ImageContent } from "../../../llm/types.js";
import type { AgentMessage } from "../../runtime/index.js";
import { agentSessionQueuePromptContext } from "../../sessions/agent-session-prompting.js";
import { getEmbeddedSessionPromptState } from "../session-prompt-state.js";

export const sessionId = "attempt-prompt-submit-test";

export function createSession() {
  const state = {
    messages: [{ role: "user", content: "transcript prompt", timestamp: 1 }] as AgentMessage[],
  };
  const baseStreamFn: StreamFn = () => {
    throw new Error("stream function should not be called directly");
  };
  const originalTransformContext = async (messages: AgentMessage[]) => messages;
  const agent = {
    state,
    streamFn: baseStreamFn,
    transformContext: originalTransformContext,
    reset: () => {
      state.messages = [];
    },
  };
  const activeSession = {
    isCompacting: false,
    [agentSessionQueuePromptContext]: vi.fn(() => () => undefined),
    get messages() {
      return state.messages;
    },
    agent,
  };
  return { activeSession, baseStreamFn, originalTransformContext };
}

export function createBaseInput() {
  const sessionPromptState = getEmbeddedSessionPromptState(sessionId);
  return {
    attempt: { sessionId },
    appendContext: "append context",
    contextTokenBudget: 8_000,
    images: [] as ImageContent[],
    modelPrompt: "model prompt",
    onFinalPromptText: vi.fn(),
    onSteeringAcknowledged: vi.fn(),
    persistToolResultProjections: vi.fn(async () => {}),
    prependContext: "prepend context",
    runtimeOnly: false,
    sessionPromptState,
    systemPrompt: "system prompt",
    toolResultAggregateMaxChars: 8_000,
    toolResultMaxChars: 4_000,
    toolResultPromptProjectionState: sessionPromptState.toolResults,
    trajectoryRecorder: null,
    transcriptLeafId: null,
    transcriptPrompt: "transcript prompt",
  };
}
