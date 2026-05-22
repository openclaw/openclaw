import { a as resolveAgentDir, o as resolveAgentWorkspaceDir } from "./agent-scope-config-yWL_27nC.js";
import "./agent-scope-CrHjLKeQ.js";
import { n as DEFAULT_MODEL, r as DEFAULT_PROVIDER } from "./defaults-BuI9Q7Ak.js";
import { i as resolveSessionFilePath, u as resolveStorePath } from "./paths-D2tVOYHR.js";
import { t as loadSessionStore } from "./store-load-6WUUNuxk.js";
import { a as saveSessionStore, c as updateSessionStoreEntry, s as updateSessionStore } from "./store-DOk7wSx2.js";
import "./sessions-XMEnIfWG.js";
import { m as resolveThinkingDefault } from "./model-selection-ClIa0TN2.js";
import { l as ensureAgentWorkspace } from "./workspace-C5nPabv4.js";
import { n as resolveAgentIdentity } from "./identity-BHO4vaI4.js";
import { t as resolveAgentTimeoutMs } from "./timeout-Tgs7VHCB.js";
import { t as runEmbeddedPiAgent } from "./pi-embedded-BZy4MOt5.js";
//#region src/extensionAPI.ts
if (process.env.VITEST !== "true" && process.env.OPENCLAW_SUPPRESS_EXTENSION_API_WARNING !== "1") process.emitWarning("openclaw/extension-api is deprecated. Migrate to api.runtime.agent.* or focused openclaw/plugin-sdk/<subpath> imports. See https://docs.openclaw.ai/plugins/sdk-migration", {
	code: "OPENCLAW_EXTENSION_API_DEPRECATED",
	detail: "This compatibility bridge is temporary. Bundled plugins should use the injected plugin runtime instead of importing host-side agent helpers directly. Migration guide: https://docs.openclaw.ai/plugins/sdk-migration"
});
//#endregion
export { DEFAULT_MODEL, DEFAULT_PROVIDER, ensureAgentWorkspace, loadSessionStore, resolveAgentDir, resolveAgentIdentity, resolveAgentTimeoutMs, resolveAgentWorkspaceDir, resolveSessionFilePath, resolveStorePath, resolveThinkingDefault, runEmbeddedPiAgent, saveSessionStore, updateSessionStore, updateSessionStoreEntry };
