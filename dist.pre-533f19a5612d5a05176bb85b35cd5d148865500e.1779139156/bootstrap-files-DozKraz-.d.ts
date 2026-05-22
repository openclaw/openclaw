import { i as OpenClawConfig } from "./types.openclaw-Bpxi7OSY.js";
import { t as EmbeddedContextFile } from "./types-CZA_uLTA.js";
import { t as WorkspaceBootstrapFile } from "./workspace-_E4HqMVx.js";
//#region src/agents/bootstrap-files.d.ts
type BootstrapContextMode = "full" | "lightweight";
type BootstrapContextRunKind = "default" | "heartbeat" | "cron";
declare function resolveBootstrapContextForRun(params: {
  workspaceDir: string;
  config?: OpenClawConfig;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
  warn?: (message: string) => void;
  contextMode?: BootstrapContextMode;
  runKind?: BootstrapContextRunKind;
}): Promise<{
  bootstrapFiles: WorkspaceBootstrapFile[];
  contextFiles: EmbeddedContextFile[];
}>;
//#endregion
export { resolveBootstrapContextForRun as t };