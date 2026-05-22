import { a as resolveAgentDir, o as resolveAgentWorkspaceDir } from "./agent-scope-config-fFkwW_47.js";
import "./agent-scope-CBctHYDw.js";
import { n as DEFAULT_MODEL, r as DEFAULT_PROVIDER } from "./defaults-BuI9Q7Ak.js";
import { i as resolveSessionFilePath, u as resolveStorePath } from "./paths-D2tVOYHR.js";
import { t as loadSessionStore } from "./store-load-CfT9U9P4.js";
import { a as saveSessionStore, c as updateSessionStoreEntry, s as updateSessionStore } from "./store-DWV_PSjG.js";
import "./sessions-DDKzhGib.js";
import { m as resolveThinkingDefault } from "./model-selection-C3RHt1lm.js";
import { l as ensureAgentWorkspace } from "./workspace-DZZ1fzl_.js";
import { n as resolveAgentIdentity } from "./identity-BdixSOJE.js";
import { t as resolveAgentTimeoutMs } from "./timeout-Tgs7VHCB.js";
import { t as runEmbeddedPiAgent } from "./pi-embedded-K1acr2yV.js";
//#region src/extensionAPI.ts
if (process.env.VITEST !== "true" && process.env.OPENCLAW_SUPPRESS_EXTENSION_API_WARNING !== "1") process.emitWarning("openclaw/extension-api is deprecated. Migrate to api.runtime.agent.* or focused openclaw/plugin-sdk/<subpath> imports. See https://docs.openclaw.ai/plugins/sdk-migration", {
	code: "OPENCLAW_EXTENSION_API_DEPRECATED",
	detail: "This compatibility bridge is temporary. Bundled plugins should use the injected plugin runtime instead of importing host-side agent helpers directly. Migration guide: https://docs.openclaw.ai/plugins/sdk-migration"
});
//#endregion
export { DEFAULT_MODEL, DEFAULT_PROVIDER, ensureAgentWorkspace, loadSessionStore, resolveAgentDir, resolveAgentIdentity, resolveAgentTimeoutMs, resolveAgentWorkspaceDir, resolveSessionFilePath, resolveStorePath, resolveThinkingDefault, runEmbeddedPiAgent, saveSessionStore, updateSessionStore, updateSessionStoreEntry };
