import "./agent-scope-TPiFaS6U.js";
import { a as resolveAgentDir, o as resolveAgentWorkspaceDir } from "./agent-scope-config-Bo5OijmI.js";
import { n as DEFAULT_MODEL, r as DEFAULT_PROVIDER } from "./defaults-CWlUbhpa.js";
import { i as resolveSessionFilePath, u as resolveStorePath } from "./paths-DEy_pmBW.js";
import { t as loadSessionStore } from "./store-load-BCIPYVeV.js";
import { a as saveSessionStore, c as updateSessionStoreEntry, s as updateSessionStore } from "./store-kjdjF6vn.js";
import "./sessions-DwDN2tCH.js";
import { m as resolveThinkingDefault } from "./model-selection-DX8uTa0m.js";
import { l as ensureAgentWorkspace } from "./workspace-D5CkWbyc.js";
import { n as resolveAgentIdentity } from "./identity-Ctb0kbd7.js";
import { t as resolveAgentTimeoutMs } from "./timeout-BSLFv0Tt.js";
import { t as runEmbeddedPiAgent } from "./pi-embedded-DgmvDOV9.js";
//#region src/extensionAPI.ts
if (process.env.VITEST !== "true" && process.env.OPENCLAW_SUPPRESS_EXTENSION_API_WARNING !== "1") process.emitWarning("openclaw/extension-api is deprecated. Migrate to api.runtime.agent.* or focused openclaw/plugin-sdk/<subpath> imports. See https://docs.openclaw.ai/plugins/sdk-migration", {
	code: "OPENCLAW_EXTENSION_API_DEPRECATED",
	detail: "This compatibility bridge is temporary. Bundled plugins should use the injected plugin runtime instead of importing host-side agent helpers directly. Migration guide: https://docs.openclaw.ai/plugins/sdk-migration"
});
//#endregion
export { DEFAULT_MODEL, DEFAULT_PROVIDER, ensureAgentWorkspace, loadSessionStore, resolveAgentDir, resolveAgentIdentity, resolveAgentTimeoutMs, resolveAgentWorkspaceDir, resolveSessionFilePath, resolveStorePath, resolveThinkingDefault, runEmbeddedPiAgent, saveSessionStore, updateSessionStore, updateSessionStoreEntry };
