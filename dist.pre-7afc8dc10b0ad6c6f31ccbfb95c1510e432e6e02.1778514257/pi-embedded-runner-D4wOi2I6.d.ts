import { _ as EmbeddedPiRunResult, r as RunEmbeddedPiAgentParams } from "./params-Ca2aO1q_.js";
import { SettingsManager } from "@mariozechner/pi-coding-agent";
import { AgentTool, StreamFn } from "@mariozechner/pi-agent-core";

//#region src/agents/pi-embedded-runner/run.d.ts
declare function runEmbeddedPiAgent(params: RunEmbeddedPiAgentParams): Promise<EmbeddedPiRunResult>;
//#endregion
export { runEmbeddedPiAgent as t };