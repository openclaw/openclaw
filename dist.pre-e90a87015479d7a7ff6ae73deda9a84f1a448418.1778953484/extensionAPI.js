import { a as resolveAgentDir, o as resolveAgentWorkspaceDir } from "./agent-scope-config-D57hqxoj.js";
import "./agent-scope-cOcI3Bf3.js";
import { n as DEFAULT_MODEL, r as DEFAULT_PROVIDER } from "./defaults-BngqyJjG.js";
import { i as resolveSessionFilePath, u as resolveStorePath } from "./paths-4e7qCqMZ.js";
import { t as loadSessionStore } from "./store-load-gabseflm.js";
import { a as saveSessionStore, c as updateSessionStoreEntry, s as updateSessionStore } from "./store-Cykejs_P.js";
import "./sessions-C96ZMbNO.js";
import { m as resolveThinkingDefault } from "./model-selection-CtlJEyaP.js";
import { l as ensureAgentWorkspace } from "./workspace-Cbmr8DnW.js";
import { n as resolveAgentIdentity } from "./identity-BNM6gytY.js";
import { t as resolveAgentTimeoutMs } from "./timeout-D990wZ-l.js";
import { t as runEmbeddedPiAgent } from "./pi-embedded-eL9JmlT0.js";
//#region src/extensionAPI.ts
if (process.env.VITEST !== "true" && process.env.OPENCLAW_SUPPRESS_EXTENSION_API_WARNING !== "1") process.emitWarning("openclaw/extension-api is deprecated. Migrate to api.runtime.agent.* or focused openclaw/plugin-sdk/<subpath> imports. See https://docs.openclaw.ai/plugins/sdk-migration", {
	code: "OPENCLAW_EXTENSION_API_DEPRECATED",
	detail: "This compatibility bridge is temporary. Bundled plugins should use the injected plugin runtime instead of importing host-side agent helpers directly. Migration guide: https://docs.openclaw.ai/plugins/sdk-migration"
});
//#endregion
export { DEFAULT_MODEL, DEFAULT_PROVIDER, ensureAgentWorkspace, loadSessionStore, resolveAgentDir, resolveAgentIdentity, resolveAgentTimeoutMs, resolveAgentWorkspaceDir, resolveSessionFilePath, resolveStorePath, resolveThinkingDefault, runEmbeddedPiAgent, saveSessionStore, updateSessionStore, updateSessionStoreEntry };
