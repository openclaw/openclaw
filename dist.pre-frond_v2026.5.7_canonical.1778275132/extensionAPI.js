import { b as resolveAgentDir, x as resolveAgentWorkspaceDir } from "./agent-scope-CcybJBoN.js";
import { n as DEFAULT_MODEL, r as DEFAULT_PROVIDER } from "./defaults-xppxcKrw.js";
import { i as resolveSessionFilePath, u as resolveStorePath } from "./paths-B_upRR9g.js";
import { t as loadSessionStore } from "./store-load-DgTW9N4P.js";
import { i as saveSessionStore, o as updateSessionStore, s as updateSessionStoreEntry } from "./store-D-yqyA6X.js";
import "./sessions-BY1AKzIp.js";
import { p as resolveThinkingDefault } from "./model-selection-BWQiz_aq.js";
import { l as ensureAgentWorkspace } from "./workspace-Dxk4lm3a.js";
import { n as resolveAgentIdentity } from "./identity-GoxySUrw.js";
import { t as resolveAgentTimeoutMs } from "./timeout-B0AiQ35K.js";
import { t as runEmbeddedPiAgent } from "./pi-embedded-IcTbURmu.js";
//#region src/extensionAPI.ts
if (process.env.VITEST !== "true" && process.env.OPENCLAW_SUPPRESS_EXTENSION_API_WARNING !== "1") process.emitWarning("openclaw/extension-api is deprecated. Migrate to api.runtime.agent.* or focused openclaw/plugin-sdk/<subpath> imports. See https://docs.openclaw.ai/plugins/sdk-migration", {
	code: "OPENCLAW_EXTENSION_API_DEPRECATED",
	detail: "This compatibility bridge is temporary. Bundled plugins should use the injected plugin runtime instead of importing host-side agent helpers directly. Migration guide: https://docs.openclaw.ai/plugins/sdk-migration"
});
//#endregion
export { DEFAULT_MODEL, DEFAULT_PROVIDER, ensureAgentWorkspace, loadSessionStore, resolveAgentDir, resolveAgentIdentity, resolveAgentTimeoutMs, resolveAgentWorkspaceDir, resolveSessionFilePath, resolveStorePath, resolveThinkingDefault, runEmbeddedPiAgent, saveSessionStore, updateSessionStore, updateSessionStoreEntry };
