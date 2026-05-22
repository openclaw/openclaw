import { a as resolveAgentDir, o as resolveAgentWorkspaceDir } from "./agent-scope-config-DKR4wP5w.js";
import "./agent-scope-ByE5d_BM.js";
import { n as DEFAULT_MODEL, r as DEFAULT_PROVIDER } from "./defaults-kkxFBlxd.js";
import { i as resolveSessionFilePath, u as resolveStorePath } from "./paths-CQN3oihN.js";
import { t as loadSessionStore } from "./store-load-D3JA5WV4.js";
import { a as saveSessionStore, c as updateSessionStoreEntry, s as updateSessionStore } from "./store-DhSIRxgg.js";
import "./sessions-BthwPU0r.js";
import { m as resolveThinkingDefault } from "./model-selection-B80gzYOd.js";
import { l as ensureAgentWorkspace } from "./workspace-JRdJwRI9.js";
import { n as resolveAgentIdentity } from "./identity-cUlHgJlw.js";
import { t as resolveAgentTimeoutMs } from "./timeout-D-dnM_AO.js";
import { t as runEmbeddedPiAgent } from "./pi-embedded-EM6rIpID.js";
//#region src/extensionAPI.ts
if (process.env.VITEST !== "true" && process.env.OPENCLAW_SUPPRESS_EXTENSION_API_WARNING !== "1") process.emitWarning("openclaw/extension-api is deprecated. Migrate to api.runtime.agent.* or focused openclaw/plugin-sdk/<subpath> imports. See https://docs.openclaw.ai/plugins/sdk-migration", {
	code: "OPENCLAW_EXTENSION_API_DEPRECATED",
	detail: "This compatibility bridge is temporary. Bundled plugins should use the injected plugin runtime instead of importing host-side agent helpers directly. Migration guide: https://docs.openclaw.ai/plugins/sdk-migration"
});
//#endregion
export { DEFAULT_MODEL, DEFAULT_PROVIDER, ensureAgentWorkspace, loadSessionStore, resolveAgentDir, resolveAgentIdentity, resolveAgentTimeoutMs, resolveAgentWorkspaceDir, resolveSessionFilePath, resolveStorePath, resolveThinkingDefault, runEmbeddedPiAgent, saveSessionStore, updateSessionStore, updateSessionStoreEntry };
