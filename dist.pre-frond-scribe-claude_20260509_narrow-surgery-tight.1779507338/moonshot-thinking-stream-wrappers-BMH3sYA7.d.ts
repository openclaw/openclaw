import { r as ThinkLevel } from "./thinking.shared-DZFlsfdo.js";
import { StreamFn } from "@earendil-works/pi-agent-core";

//#region src/agents/pi-embedded-runner/moonshot-thinking-stream-wrappers.d.ts
type MoonshotThinkingType = "enabled" | "disabled";
type MoonshotThinkingKeep = "all";
/** @deprecated Moonshot provider-owned stream helper; do not use from third-party plugins. */
declare function resolveMoonshotThinkingType(params: {
  configuredThinking: unknown;
  thinkingLevel?: ThinkLevel;
}): MoonshotThinkingType | undefined;
/** @deprecated Moonshot provider-owned stream helper; do not use from third-party plugins. */
declare function createMoonshotThinkingWrapper(baseStreamFn: StreamFn | undefined, thinkingType?: MoonshotThinkingType, thinkingKeep?: MoonshotThinkingKeep): StreamFn;
//#endregion
export { resolveMoonshotThinkingType as n, createMoonshotThinkingWrapper as t };