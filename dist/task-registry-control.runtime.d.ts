import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { t as getAcpSessionManager } from "./manager-C-szsexz.js";
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