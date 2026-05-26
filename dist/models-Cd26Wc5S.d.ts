import { r as CodexAppServerStartOptions } from "./client-DWZAI6aL.js";
import { t as resolveCodexAppServerAuthProfileIdForAgent } from "./auth-bridge-BH4BfT-B.js";

//#region extensions/codex/src/app-server/models.d.ts
type CodexAppServerModel = {
  id: string;
  model: string;
  displayName?: string;
  description?: string;
  hidden?: boolean;
  isDefault?: boolean;
  inputModalities: string[];
  supportedReasoningEfforts: string[];
  defaultReasoningEffort?: string;
};
type CodexAppServerModelListResult = {
  models: CodexAppServerModel[];
  nextCursor?: string;
  truncated?: boolean;
};
type CodexAppServerListModelsOptions = {
  limit?: number;
  cursor?: string;
  includeHidden?: boolean;
  timeoutMs?: number;
  startOptions?: CodexAppServerStartOptions;
  authProfileId?: string;
  agentDir?: string;
  config?: Parameters<typeof resolveCodexAppServerAuthProfileIdForAgent>[0]["config"];
  sharedClient?: boolean;
};
//#endregion
export { CodexAppServerModel as n, CodexAppServerModelListResult as r, CodexAppServerListModelsOptions as t };