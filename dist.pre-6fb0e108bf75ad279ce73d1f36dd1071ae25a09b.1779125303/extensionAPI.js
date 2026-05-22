import "./agent-scope-rw2bYM9R.js";
import { a as resolveAgentDir, o as resolveAgentWorkspaceDir } from "./agent-scope-config-DdvF1onI.js";
import { n as DEFAULT_MODEL, r as DEFAULT_PROVIDER } from "./defaults-DQNxPE51.js";
import { i as resolveSessionFilePath, u as resolveStorePath } from "./paths-_BPRx1WO.js";
import { t as loadSessionStore } from "./store-load-CummK8JT.js";
import { a as saveSessionStore, c as updateSessionStoreEntry, s as updateSessionStore } from "./store-B9TKWqn_.js";
import "./sessions-CFVisdNZ.js";
import { m as resolveThinkingDefault } from "./model-selection-CiNpBU0C.js";
import { l as ensureAgentWorkspace } from "./workspace-CvbkPv2B.js";
import { n as resolveAgentIdentity } from "./identity-DO0zSSTT.js";
import { t as resolveAgentTimeoutMs } from "./timeout-C5-yOoIv.js";
import { t as runEmbeddedPiAgent } from "./pi-embedded-BW3NxDoG.js";
//#region src/extensionAPI.ts
if (process.env.VITEST !== "true" && process.env.OPENCLAW_SUPPRESS_EXTENSION_API_WARNING !== "1") process.emitWarning("openclaw/extension-api is deprecated. Migrate to api.runtime.agent.* or focused openclaw/plugin-sdk/<subpath> imports. See https://docs.openclaw.ai/plugins/sdk-migration", {
	code: "OPENCLAW_EXTENSION_API_DEPRECATED",
	detail: "This compatibility bridge is temporary. Bundled plugins should use the injected plugin runtime instead of importing host-side agent helpers directly. Migration guide: https://docs.openclaw.ai/plugins/sdk-migration"
});
//#endregion
export { DEFAULT_MODEL, DEFAULT_PROVIDER, ensureAgentWorkspace, loadSessionStore, resolveAgentDir, resolveAgentIdentity, resolveAgentTimeoutMs, resolveAgentWorkspaceDir, resolveSessionFilePath, resolveStorePath, resolveThinkingDefault, runEmbeddedPiAgent, saveSessionStore, updateSessionStore, updateSessionStoreEntry };
