import { a as resolveAgentDir, o as resolveAgentWorkspaceDir } from "./agent-scope-config-DKR4wP5w.js";
import "./agent-scope-ByE5d_BM.js";
import { n as DEFAULT_MODEL, r as DEFAULT_PROVIDER } from "./defaults-kkxFBlxd.js";
import { i as resolveSessionFilePath, u as resolveStorePath } from "./paths-CaksWsrq.js";
import { t as loadSessionStore } from "./store-load-qCUuej4o.js";
import { a as saveSessionStore, c as updateSessionStoreEntry, s as updateSessionStore } from "./store-DFBhxZSz.js";
import "./sessions-Do2ziPO_.js";
import { m as resolveThinkingDefault } from "./model-selection-DXhHIora.js";
import { l as ensureAgentWorkspace } from "./workspace-S7Sb_AzB.js";
import { n as resolveAgentIdentity } from "./identity-BsLn8TPu.js";
import { t as resolveAgentTimeoutMs } from "./timeout-Cf3dLTGC.js";
import { t as runEmbeddedPiAgent } from "./pi-embedded-BvhL9isj.js";
//#region src/extensionAPI.ts
if (process.env.VITEST !== "true" && process.env.OPENCLAW_SUPPRESS_EXTENSION_API_WARNING !== "1") process.emitWarning("openclaw/extension-api is deprecated. Migrate to api.runtime.agent.* or focused openclaw/plugin-sdk/<subpath> imports. See https://docs.openclaw.ai/plugins/sdk-migration", {
	code: "OPENCLAW_EXTENSION_API_DEPRECATED",
	detail: "This compatibility bridge is temporary. Bundled plugins should use the injected plugin runtime instead of importing host-side agent helpers directly. Migration guide: https://docs.openclaw.ai/plugins/sdk-migration"
});
//#endregion
export { DEFAULT_MODEL, DEFAULT_PROVIDER, ensureAgentWorkspace, loadSessionStore, resolveAgentDir, resolveAgentIdentity, resolveAgentTimeoutMs, resolveAgentWorkspaceDir, resolveSessionFilePath, resolveStorePath, resolveThinkingDefault, runEmbeddedPiAgent, saveSessionStore, updateSessionStore, updateSessionStoreEntry };
