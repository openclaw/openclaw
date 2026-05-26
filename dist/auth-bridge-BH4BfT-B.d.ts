import { _ as resolveAuthProfileOrder } from "./auth-profiles-BTU94ovy.js";

//#region extensions/codex/src/app-server/auth-bridge.d.ts
type AuthProfileOrderConfig = Parameters<typeof resolveAuthProfileOrder>[0]["cfg"];
declare function resolveCodexAppServerAuthProfileIdForAgent(params: {
  authProfileId?: string;
  agentDir?: string;
  config?: AuthProfileOrderConfig;
}): string | undefined;
//#endregion
export { resolveCodexAppServerAuthProfileIdForAgent as t };