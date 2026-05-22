import { r as ThinkLevel } from "./thinking.shared-D3hXUZEF.js";
import { StreamFn } from "@mariozechner/pi-agent-core";

//#region src/agents/pi-embedded-runner/moonshot-thinking-stream-wrappers.d.ts
type MoonshotThinkingType = "enabled" | "disabled";
type MoonshotThinkingKeep = "all";
declare function resolveMoonshotThinkingType(params: {
  configuredThinking: unknown;
  thinkingLevel?: ThinkLevel;
}): MoonshotThinkingType | undefined;
declare function createMoonshotThinkingWrapper(baseStreamFn: StreamFn | undefined, thinkingType?: MoonshotThinkingType, thinkingKeep?: MoonshotThinkingKeep): StreamFn;
//#endregion
export { resolveMoonshotThinkingType as n, createMoonshotThinkingWrapper as t };