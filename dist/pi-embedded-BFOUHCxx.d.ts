import { h as EmbeddedPiRunResult, r as RunEmbeddedPiAgentParams } from "./params-C8lj3xSa.js";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { AgentTool, StreamFn } from "@earendil-works/pi-agent-core";

//#region src/agents/pi-embedded-runner/run.d.ts
declare function runEmbeddedPiAgent(params: RunEmbeddedPiAgentParams): Promise<EmbeddedPiRunResult>;
//#endregion
export { runEmbeddedPiAgent as t };