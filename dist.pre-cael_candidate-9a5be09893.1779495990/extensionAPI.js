import "./agent-scope-Bl5pjInQ.js";
import { a as resolveAgentDir, o as resolveAgentWorkspaceDir } from "./agent-scope-config-Dm11aCiH.js";
import { n as DEFAULT_MODEL, r as DEFAULT_PROVIDER } from "./defaults-mDjiWzE5.js";
import { i as resolveSessionFilePath, u as resolveStorePath } from "./paths-DE6QEn2i.js";
import { t as loadSessionStore } from "./store-load-BKiPIr-m.js";
import { a as saveSessionStore, c as updateSessionStoreEntry, s as updateSessionStore } from "./store-CSNEKBzE.js";
import "./sessions-BgVGK7Hj.js";
import { m as resolveThinkingDefault } from "./model-selection-Buvz1_IB.js";
import { l as ensureAgentWorkspace } from "./workspace-C8KVpHa_.js";
import { n as resolveAgentIdentity } from "./identity-CO-SOE_j.js";
import { t as resolveAgentTimeoutMs } from "./timeout-DQpX0NNX.js";
import { t as runEmbeddedPiAgent } from "./pi-embedded-D6R6ZO_T.js";
//#region src/extensionAPI.ts
if (process.env.VITEST !== "true" && process.env.OPENCLAW_SUPPRESS_EXTENSION_API_WARNING !== "1") process.emitWarning("openclaw/extension-api is deprecated. Migrate to api.runtime.agent.* or focused openclaw/plugin-sdk/<subpath> imports. See https://docs.openclaw.ai/plugins/sdk-migration", {
	code: "OPENCLAW_EXTENSION_API_DEPRECATED",
	detail: "This compatibility bridge is temporary. Bundled plugins should use the injected plugin runtime instead of importing host-side agent helpers directly. Migration guide: https://docs.openclaw.ai/plugins/sdk-migration"
});
//#endregion
export { DEFAULT_MODEL, DEFAULT_PROVIDER, ensureAgentWorkspace, loadSessionStore, resolveAgentDir, resolveAgentIdentity, resolveAgentTimeoutMs, resolveAgentWorkspaceDir, resolveSessionFilePath, resolveStorePath, resolveThinkingDefault, runEmbeddedPiAgent, saveSessionStore, updateSessionStore, updateSessionStoreEntry };
