import "./agent-scope-rw2bYM9R.js";
import { a as resolveAgentDir, o as resolveAgentWorkspaceDir } from "./agent-scope-config-DdvF1onI.js";
import { n as DEFAULT_MODEL, r as DEFAULT_PROVIDER } from "./defaults-DQNxPE51.js";
import { i as resolveSessionFilePath, u as resolveStorePath } from "./paths-_BPRx1WO.js";
import { t as loadSessionStore } from "./store-load-NR217KeP.js";
import { a as saveSessionStore, c as updateSessionStoreEntry, s as updateSessionStore } from "./store-DM2Qj4Ie.js";
import "./sessions-Buwioyq3.js";
import { m as resolveThinkingDefault } from "./model-selection-BGs61_ek.js";
import { l as ensureAgentWorkspace } from "./workspace-CvbkPv2B.js";
import { n as resolveAgentIdentity } from "./identity-DO0zSSTT.js";
import { t as resolveAgentTimeoutMs } from "./timeout-C5-yOoIv.js";
import { t as runEmbeddedPiAgent } from "./pi-embedded-CuyHpwp9.js";
//#region src/extensionAPI.ts
if (process.env.VITEST !== "true" && process.env.OPENCLAW_SUPPRESS_EXTENSION_API_WARNING !== "1") process.emitWarning("openclaw/extension-api is deprecated. Migrate to api.runtime.agent.* or focused openclaw/plugin-sdk/<subpath> imports. See https://docs.openclaw.ai/plugins/sdk-migration", {
	code: "OPENCLAW_EXTENSION_API_DEPRECATED",
	detail: "This compatibility bridge is temporary. Bundled plugins should use the injected plugin runtime instead of importing host-side agent helpers directly. Migration guide: https://docs.openclaw.ai/plugins/sdk-migration"
});
//#endregion
export { DEFAULT_MODEL, DEFAULT_PROVIDER, ensureAgentWorkspace, loadSessionStore, resolveAgentDir, resolveAgentIdentity, resolveAgentTimeoutMs, resolveAgentWorkspaceDir, resolveSessionFilePath, resolveStorePath, resolveThinkingDefault, runEmbeddedPiAgent, saveSessionStore, updateSessionStore, updateSessionStoreEntry };
