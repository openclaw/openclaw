import { runAgentLoop } from "./agent-loop.js";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage, StreamFn } from "./types.js";

export function captureAgentLoop(
  prompts: AgentMessage[],
  context: AgentContext,
  loopConfig: AgentLoopConfig,
  signal?: AbortSignal,
  streamFn?: StreamFn,
) {
  const events: AgentEvent[] = [];
  const result = runAgentLoop(
    prompts,
    context,
    loopConfig,
    (event) => {
      events.push(event);
    },
    signal,
    streamFn,
  );
  return { events, result };
}

export async function collectEvents(
  run: ReturnType<typeof captureAgentLoop>,
): Promise<AgentEvent[]> {
  await run.result;
  return run.events;
}
