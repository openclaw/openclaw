import { f as MediaUnderstandingProvider } from "../../types-Dp2r6Yla.js";
import { r as CodexAppServerStartOptions, t as CodexAppServerClient } from "../../client-BSR0BBYz.js";
import { t as resolveCodexAppServerAuthProfileIdForAgent } from "../../auth-bridge-B6PgZE5G.js";

//#region extensions/codex/src/app-server/client-factory.d.ts
type AuthProfileOrderConfig = Parameters<typeof resolveCodexAppServerAuthProfileIdForAgent>[0]["config"];
type CodexAppServerClientFactory = (startOptions?: CodexAppServerStartOptions, authProfileId?: string, agentDir?: string, config?: AuthProfileOrderConfig) => Promise<CodexAppServerClient>;
//#endregion
//#region extensions/codex/media-understanding-provider.d.ts
type CodexMediaUnderstandingProviderOptions = {
  pluginConfig?: unknown;
  clientFactory?: CodexAppServerClientFactory;
};
declare function buildCodexMediaUnderstandingProvider(options?: CodexMediaUnderstandingProviderOptions): MediaUnderstandingProvider;
//#endregion
export { CodexMediaUnderstandingProviderOptions, buildCodexMediaUnderstandingProvider };