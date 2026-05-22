import { i as OpenClawConfig } from "./types.openclaw-Cy0U3Gwh.js";
import { t as getAcpSessionManager } from "./manager-CDXAykl4.js";
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