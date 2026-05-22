import { n as NATIVE_ANTHROPIC_REPLAY_HOOKS } from "./provider-model-shared-Cg5K9Gwb.js";
//#region extensions/anthropic/replay-policy.ts
const { buildReplayPolicy } = NATIVE_ANTHROPIC_REPLAY_HOOKS;
if (!buildReplayPolicy) throw new Error("Expected native Anthropic replay hooks to expose buildReplayPolicy.");
//#endregion
export { buildReplayPolicy as t };
