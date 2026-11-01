import type { Agent, StreamFn } from "../../runtime/index.js";
import type { agentSessionSetContextReplacementHook } from "../../sessions/agent-session-compaction.js";
import type {
  agentSessionQueuePromptContext,
  agentSessionSetPromptPreparation,
} from "../../sessions/agent-session-prompting.js";
import type { AgentSession } from "../../sessions/agent-session.js";
import type { CreateAgentSessionOptions } from "../../sessions/index.js";

export type MutableSession = {
  sessionId: string;
  sessionManager?: CreateAgentSessionOptions["sessionManager"];
  messages: unknown[];
  isCompacting: boolean;
  isStreaming: boolean;
  subscribe: AgentSession["subscribe"];
  agent: {
    convertToLlm: Agent["convertToLlm"];
    prompt?: (...args: unknown[]) => Promise<unknown>;
    streamFn?: (...args: Parameters<StreamFn>) => Promise<unknown>;
    transport?: string;
    subscribe?: Agent["subscribe"];
    reset: () => void;
    state: Pick<Agent["state"], "systemPrompt" | "tools"> & { messages: unknown[] };
  };
  prompt: (
    prompt: string,
    options?: { images?: unknown[]; preflightResult?: (submitted: boolean) => void },
  ) => Promise<void>;
  setBaseSystemPrompt: (systemPrompt: string) => void;
  sendCustomMessage: AgentSession["sendCustomMessage"];
  getActiveToolNames: () => string[];
  getToolDefinition: AgentSession["getToolDefinition"];
  setActiveToolsByName: (toolNames: string[]) => void;
  abort: () => Promise<void>;
  dispose: () => void;
  steer: (text: string) => Promise<void>;
  [agentSessionSetContextReplacementHook]: AgentSession[typeof agentSessionSetContextReplacementHook];
  [agentSessionSetPromptPreparation]: AgentSession[typeof agentSessionSetPromptPreparation];
  [agentSessionQueuePromptContext]: AgentSession[typeof agentSessionQueuePromptContext];
};

type PromptPreparation = Parameters<AgentSession[typeof agentSessionSetPromptPreparation]>[0];
type PromptContext = Parameters<AgentSession[typeof agentSessionQueuePromptContext]>[0];

/** Cancel unsent context; admitted prompts consume it once into their retained history. */
export function createTestPromptContextQueue(append: (message: PromptContext) => void) {
  const pending = new Set<PromptContext>();
  function queue(message: PromptContext): () => void;
  function queue(message: PromptContext, options: { delivery: "current-request" }): Promise<void>;
  function queue(message: PromptContext, options?: { delivery: "current-request" }) {
    if (options) {
      append(message);
      return Promise.resolve();
    }
    pending.add(message);
    return () => {
      pending.delete(message);
    };
  }
  return {
    queue,
    flush() {
      const messages = [...pending];
      pending.clear();
      messages.forEach(append);
    },
  };
}

/** The fake session consumes the host admission before entering its composed prompt. */
export async function runPreparedTestPrompt(
  getPreparation: () => PromptPreparation,
  run: () => Promise<void>,
): Promise<void> {
  const currentPreparation = getPreparation();
  if (!currentPreparation) {
    return run();
  }
  const admit = await currentPreparation();
  const assertCurrent = () => {
    if (currentPreparation !== getPreparation()) {
      throw new Error("Session prompt preparation is stale after replacement or disposal.");
    }
  };
  assertCurrent();
  let running: Promise<void> | undefined;
  const start = (commit?: () => void) => {
    assertCurrent();
    commit?.();
    assertCurrent();
    running = run();
    // Observe rejection while admission settles; await the original promise below.
    void running.catch(() => {});
  };
  try {
    if (admit) {
      await admit(start);
    } else {
      start();
    }
  } catch (error) {
    await running?.catch(() => {});
    throw error;
  }
  if (!running) {
    throw new Error("Session prompt admission did not start the agent loop.");
  }
  await running;
}
