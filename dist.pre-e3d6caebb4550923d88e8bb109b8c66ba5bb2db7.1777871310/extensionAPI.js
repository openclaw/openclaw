import { b as resolveAgentDir, x as resolveAgentWorkspaceDir } from "./agent-scope-CbabgXwH.js";
import { n as DEFAULT_MODEL, r as DEFAULT_PROVIDER } from "./defaults-CHyQiMS4.js";
import { i as resolveSessionFilePath, u as resolveStorePath } from "./paths-Dl79wsM6.js";
import { t as loadSessionStore } from "./store-load-BJuxv-vp.js";
import { i as saveSessionStore, o as updateSessionStore, s as updateSessionStoreEntry } from "./store-IyLBOjUO.js";
import "./sessions-DCQidobb.js";
import { p as resolveThinkingDefault } from "./model-selection-aDhlumjq.js";
import { l as ensureAgentWorkspace } from "./workspace-BJnGgOZY.js";
import { n as resolveAgentIdentity } from "./identity-Be40H-5J.js";
import { t as resolveAgentTimeoutMs } from "./timeout-7xlfF7jP.js";
import { t as runEmbeddedPiAgent } from "./pi-embedded-fZrHF6W5.js";
//#region src/extensionAPI.ts
if (process.env.VITEST !== "true" && process.env.OPENCLAW_SUPPRESS_EXTENSION_API_WARNING !== "1") process.emitWarning("openclaw/extension-api is deprecated. Migrate to api.runtime.agent.* or focused openclaw/plugin-sdk/<subpath> imports. See https://docs.openclaw.ai/plugins/sdk-migration", {
	code: "OPENCLAW_EXTENSION_API_DEPRECATED",
	detail: "This compatibility bridge is temporary. Bundled plugins should use the injected plugin runtime instead of importing host-side agent helpers directly. Migration guide: https://docs.openclaw.ai/plugins/sdk-migration"
});
//#endregion
export { DEFAULT_MODEL, DEFAULT_PROVIDER, ensureAgentWorkspace, loadSessionStore, resolveAgentDir, resolveAgentIdentity, resolveAgentTimeoutMs, resolveAgentWorkspaceDir, resolveSessionFilePath, resolveStorePath, resolveThinkingDefault, runEmbeddedPiAgent, saveSessionStore, updateSessionStore, updateSessionStoreEntry };
