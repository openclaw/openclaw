import "./agent-scope-C5uhMtO-.js";
import { a as resolveAgentDir, o as resolveAgentWorkspaceDir } from "./agent-scope-config-BWnA6LIS.js";
import { n as DEFAULT_MODEL, r as DEFAULT_PROVIDER } from "./defaults-CWlUbhpa.js";
import { i as resolveSessionFilePath, u as resolveStorePath } from "./paths-Bapt3qQT.js";
import { t as loadSessionStore } from "./store-load-lvssy8TE.js";
import { a as saveSessionStore, c as updateSessionStoreEntry, s as updateSessionStore } from "./store-BqYSXyaO.js";
import "./sessions-BVCHk8wn.js";
import { m as resolveThinkingDefault } from "./model-selection-T92uY7wQ.js";
import { l as ensureAgentWorkspace } from "./workspace-DuUxZXiF.js";
import { n as resolveAgentIdentity } from "./identity-D5z0nCHc.js";
import { t as resolveAgentTimeoutMs } from "./timeout-ugqBEe-L.js";
import { t as runEmbeddedPiAgent } from "./pi-embedded-C8-Hks7e.js";
//#region src/extensionAPI.ts
if (process.env.VITEST !== "true" && process.env.OPENCLAW_SUPPRESS_EXTENSION_API_WARNING !== "1") process.emitWarning("openclaw/extension-api is deprecated. Migrate to api.runtime.agent.* or focused openclaw/plugin-sdk/<subpath> imports. See https://docs.openclaw.ai/plugins/sdk-migration", {
	code: "OPENCLAW_EXTENSION_API_DEPRECATED",
	detail: "This compatibility bridge is temporary. Bundled plugins should use the injected plugin runtime instead of importing host-side agent helpers directly. Migration guide: https://docs.openclaw.ai/plugins/sdk-migration"
});
//#endregion
export { DEFAULT_MODEL, DEFAULT_PROVIDER, ensureAgentWorkspace, loadSessionStore, resolveAgentDir, resolveAgentIdentity, resolveAgentTimeoutMs, resolveAgentWorkspaceDir, resolveSessionFilePath, resolveStorePath, resolveThinkingDefault, runEmbeddedPiAgent, saveSessionStore, updateSessionStore, updateSessionStoreEntry };
