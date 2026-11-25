import type { EventFrame } from "../../packages/gateway-protocol/src/index.js";
import { createPromptScenario } from "./translator.scenario.test-support.js";

export const DEFAULT_SESSION_KEY = "agent:main:main";

export async function createPendingPromptHarness() {
  const { agent, sessionUpdate, active } = createPromptScenario();
  const { result: promptPromise, runId } = await active();
  return { agent, promptPromise, runId, sessionUpdate };
}

export function createChatEvent(payload: Record<string, unknown>): EventFrame {
  return { type: "event", event: "chat", payload } as EventFrame;
}
