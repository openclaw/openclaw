import "./agent-scope-C51VTAKH.js";
import { a as resolveAgentDir, o as resolveAgentWorkspaceDir } from "./agent-scope-config-C5zL9i5G.js";
import { n as DEFAULT_MODEL, r as DEFAULT_PROVIDER } from "./defaults-mDjiWzE5.js";
import { i as resolveSessionFilePath, u as resolveStorePath } from "./paths-DE6QEn2i.js";
import { t as loadSessionStore } from "./store-load-QI_1eBWp.js";
import { a as saveSessionStore, c as updateSessionStoreEntry, s as updateSessionStore } from "./store-r4WEtwxi.js";
import "./sessions-Cq6eeDnZ.js";
import { m as resolveThinkingDefault } from "./model-selection-KwD0KwGN.js";
import { l as ensureAgentWorkspace } from "./workspace-Czw4sUL8.js";
import { n as resolveAgentIdentity } from "./identity-D1W0mdWU.js";
import { t as resolveAgentTimeoutMs } from "./timeout-DQpX0NNX.js";
import { t as runEmbeddedPiAgent } from "./pi-embedded-D4-eJ3Cf.js";
//#region src/extensionAPI.ts
if (process.env.VITEST !== "true" && process.env.OPENCLAW_SUPPRESS_EXTENSION_API_WARNING !== "1") process.emitWarning("openclaw/extension-api is deprecated. Migrate to api.runtime.agent.* or focused openclaw/plugin-sdk/<subpath> imports. See https://docs.openclaw.ai/plugins/sdk-migration", {
	code: "OPENCLAW_EXTENSION_API_DEPRECATED",
	detail: "This compatibility bridge is temporary. Bundled plugins should use the injected plugin runtime instead of importing host-side agent helpers directly. Migration guide: https://docs.openclaw.ai/plugins/sdk-migration"
});
//#endregion
export { DEFAULT_MODEL, DEFAULT_PROVIDER, ensureAgentWorkspace, loadSessionStore, resolveAgentDir, resolveAgentIdentity, resolveAgentTimeoutMs, resolveAgentWorkspaceDir, resolveSessionFilePath, resolveStorePath, resolveThinkingDefault, runEmbeddedPiAgent, saveSessionStore, updateSessionStore, updateSessionStoreEntry };
