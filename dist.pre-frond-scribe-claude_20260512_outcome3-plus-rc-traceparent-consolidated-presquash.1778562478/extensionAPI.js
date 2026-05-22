import { b as resolveAgentDir, x as resolveAgentWorkspaceDir } from "./agent-scope-CcybJBoN.js";
import { n as DEFAULT_MODEL, r as DEFAULT_PROVIDER } from "./defaults-xppxcKrw.js";
import { a as resolveSessionFilePath, d as resolveStorePath } from "./paths-Dai9rPIo.js";
import { t as loadSessionStore } from "./store-load-CREfM4qQ.js";
import { i as saveSessionStore, o as updateSessionStore, s as updateSessionStoreEntry } from "./store-L0DKoc8m.js";
import "./sessions-vUaNmv0h.js";
import { p as resolveThinkingDefault } from "./model-selection-CyWx9aXc.js";
import { l as ensureAgentWorkspace } from "./workspace-BY7PlQ5_.js";
import { n as resolveAgentIdentity } from "./identity-D0LXZhU5.js";
import { t as resolveAgentTimeoutMs } from "./timeout-2RGlpelQ.js";
import { t as runEmbeddedPiAgent } from "./pi-embedded-CDyxAHh3.js";
//#region src/extensionAPI.ts
if (process.env.VITEST !== "true" && process.env.OPENCLAW_SUPPRESS_EXTENSION_API_WARNING !== "1") process.emitWarning("openclaw/extension-api is deprecated. Migrate to api.runtime.agent.* or focused openclaw/plugin-sdk/<subpath> imports. See https://docs.openclaw.ai/plugins/sdk-migration", {
	code: "OPENCLAW_EXTENSION_API_DEPRECATED",
	detail: "This compatibility bridge is temporary. Bundled plugins should use the injected plugin runtime instead of importing host-side agent helpers directly. Migration guide: https://docs.openclaw.ai/plugins/sdk-migration"
});
//#endregion
export { DEFAULT_MODEL, DEFAULT_PROVIDER, ensureAgentWorkspace, loadSessionStore, resolveAgentDir, resolveAgentIdentity, resolveAgentTimeoutMs, resolveAgentWorkspaceDir, resolveSessionFilePath, resolveStorePath, resolveThinkingDefault, runEmbeddedPiAgent, saveSessionStore, updateSessionStore, updateSessionStoreEntry };
