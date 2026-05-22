import { n as NATIVE_ANTHROPIC_REPLAY_HOOKS } from "./provider-model-shared-CaJQJU2U.js";
//#region extensions/anthropic/replay-policy.ts
const { buildReplayPolicy } = NATIVE_ANTHROPIC_REPLAY_HOOKS;
if (!buildReplayPolicy) throw new Error("Expected native Anthropic replay hooks to expose buildReplayPolicy.");
//#endregion
export { buildReplayPolicy as t };
