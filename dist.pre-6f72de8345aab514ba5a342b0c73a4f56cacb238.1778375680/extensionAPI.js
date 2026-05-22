import { a as resolveAgentDir, o as resolveAgentWorkspaceDir } from "./agent-scope-config-BUbm4C3v.js";
import "./agent-scope-CcthxFej.js";
import { n as DEFAULT_MODEL, r as DEFAULT_PROVIDER } from "./defaults-CwXEAnpT.js";
import { i as resolveSessionFilePath, u as resolveStorePath } from "./paths-BYkpLqJF.js";
import { t as loadSessionStore } from "./store-load-CR507N_-.js";
import { a as saveSessionStore, c as updateSessionStoreEntry, s as updateSessionStore } from "./store-bHMyvLAj.js";
import "./sessions-BPwe-yj6.js";
import { m as resolveThinkingDefault } from "./model-selection-DDEg6aT2.js";
import { l as ensureAgentWorkspace } from "./workspace-CR1JECjq.js";
import { n as resolveAgentIdentity } from "./identity-Kb0CusYZ.js";
import { t as resolveAgentTimeoutMs } from "./timeout-C11nQnnf.js";
import { t as runEmbeddedPiAgent } from "./pi-embedded-DnXXz-5S.js";
//#region src/extensionAPI.ts
if (process.env.VITEST !== "true" && process.env.OPENCLAW_SUPPRESS_EXTENSION_API_WARNING !== "1") process.emitWarning("openclaw/extension-api is deprecated. Migrate to api.runtime.agent.* or focused openclaw/plugin-sdk/<subpath> imports. See https://docs.openclaw.ai/plugins/sdk-migration", {
	code: "OPENCLAW_EXTENSION_API_DEPRECATED",
	detail: "This compatibility bridge is temporary. Bundled plugins should use the injected plugin runtime instead of importing host-side agent helpers directly. Migration guide: https://docs.openclaw.ai/plugins/sdk-migration"
});
//#endregion
export { DEFAULT_MODEL, DEFAULT_PROVIDER, ensureAgentWorkspace, loadSessionStore, resolveAgentDir, resolveAgentIdentity, resolveAgentTimeoutMs, resolveAgentWorkspaceDir, resolveSessionFilePath, resolveStorePath, resolveThinkingDefault, runEmbeddedPiAgent, saveSessionStore, updateSessionStore, updateSessionStoreEntry };
