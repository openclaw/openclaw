import "./agent-scope-DKjUWHDL.js";
import { a as resolveAgentDir, o as resolveAgentWorkspaceDir } from "./agent-scope-config-D1eqrBeU.js";
import { n as DEFAULT_MODEL, r as DEFAULT_PROVIDER } from "./defaults-mDjiWzE5.js";
import { i as resolveSessionFilePath, u as resolveStorePath } from "./paths---FlWJ0A.js";
import { t as loadSessionStore } from "./store-load-DM26fo1a.js";
import { c as saveSessionStore, d as updateSessionStoreEntry, u as updateSessionStore } from "./store-CuGD5gZu.js";
import "./sessions-CtFd7seb.js";
import { m as resolveThinkingDefault } from "./model-selection-BSyRhVPt.js";
import { l as ensureAgentWorkspace } from "./workspace-D9JVjqOO.js";
import { n as resolveAgentIdentity } from "./identity-BspxvuU6.js";
import { t as resolveAgentTimeoutMs } from "./timeout-DvDp8cBn.js";
import { t as runEmbeddedPiAgent } from "./pi-embedded-BHa06r-a.js";
//#region src/extensionAPI.ts
if (process.env.VITEST !== "true" && process.env.OPENCLAW_SUPPRESS_EXTENSION_API_WARNING !== "1") process.emitWarning("openclaw/extension-api is deprecated. Migrate to api.runtime.agent.* or focused openclaw/plugin-sdk/<subpath> imports. See https://docs.openclaw.ai/plugins/sdk-migration", {
	code: "OPENCLAW_EXTENSION_API_DEPRECATED",
	detail: "This compatibility bridge is temporary. Bundled plugins should use the injected plugin runtime instead of importing host-side agent helpers directly. Migration guide: https://docs.openclaw.ai/plugins/sdk-migration"
});
//#endregion
export { DEFAULT_MODEL, DEFAULT_PROVIDER, ensureAgentWorkspace, loadSessionStore, resolveAgentDir, resolveAgentIdentity, resolveAgentTimeoutMs, resolveAgentWorkspaceDir, resolveSessionFilePath, resolveStorePath, resolveThinkingDefault, runEmbeddedPiAgent, saveSessionStore, updateSessionStore, updateSessionStoreEntry };
