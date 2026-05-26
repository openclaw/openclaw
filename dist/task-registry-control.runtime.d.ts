import { i as OpenClawConfig } from "./types.openclaw-DIZy8jcb.js";
import { n as getAcpSessionManager } from "./manager-BhjqqASr.js";
//#region src/agents/subagent-control.d.ts
declare function killSubagentRunAdmin(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
}): Promise<{
  found: false;
  killed: boolean;
  runId?: undefined;
  sessionKey?: undefined;
  cascadeKilled?: undefined;
  cascadeLabels?: undefined;
} | {
  found: true;
  killed: boolean;
  runId: string;
  sessionKey: string;
  cascadeKilled: number;
  cascadeLabels: string[] | undefined;
}>;
//#endregion
export { getAcpSessionManager, killSubagentRunAdmin };