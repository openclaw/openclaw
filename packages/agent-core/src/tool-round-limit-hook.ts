export type ToolRoundLimitHook = (round: number) => boolean | Promise<boolean>;

const TOOL_ROUND_LIMIT = Symbol("openclaw.toolRoundLimit");
const agentToolRoundLimits = new WeakMap<object, ToolRoundLimitHook>();

type ToolRoundLimitCarrier = {
  [TOOL_ROUND_LIMIT]?: ToolRoundLimitHook;
};

export function setAgentToolRoundLimit(agent: object, hook?: ToolRoundLimitHook): void {
  if (hook) {
    agentToolRoundLimits.set(agent, hook);
  } else {
    agentToolRoundLimits.delete(agent);
  }
}

export function withAgentToolRoundLimit<T extends object>(config: T, agent: object): T {
  const hook = agentToolRoundLimits.get(agent);
  return hook ? withToolRoundLimit(config, hook) : config;
}

export function withToolRoundLimit<T extends object>(config: T, hook: ToolRoundLimitHook): T {
  return Object.assign(config, { [TOOL_ROUND_LIMIT]: hook });
}

export async function continueToolRound(config: object, round: number): Promise<boolean> {
  return (await (config as ToolRoundLimitCarrier)[TOOL_ROUND_LIMIT]?.(round)) !== false;
}
