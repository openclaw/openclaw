import { i as OpenClawConfig } from "./types.openclaw-BlE9q7jU.js";
import { n as getAcpSessionManager } from "./manager-quBUaMKt.js";
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