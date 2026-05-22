import { a as resolveAgentDir, o as resolveAgentWorkspaceDir } from "./agent-scope-config-Du7CC6LK.js";
import "./agent-scope-q0THteOR.js";
import { n as DEFAULT_MODEL, r as DEFAULT_PROVIDER } from "./defaults-q2a3Ic6o.js";
import { i as resolveSessionFilePath, u as resolveStorePath } from "./paths-B3IZXng3.js";
import { t as loadSessionStore } from "./store-load-B202ZRGn.js";
import { a as saveSessionStore, c as updateSessionStoreEntry, s as updateSessionStore } from "./store-Dn6p-fz_.js";
import "./sessions-CaK_EJUM.js";
import { m as resolveThinkingDefault } from "./model-selection-OBfqg2ku.js";
import { l as ensureAgentWorkspace } from "./workspace-DGp6t83K.js";
import { n as resolveAgentIdentity } from "./identity-DHXLdIz3.js";
import { t as resolveAgentTimeoutMs } from "./timeout-BvXKASTh.js";
import { t as runEmbeddedPiAgent } from "./pi-embedded-CtFn3VgF.js";
//#region src/extensionAPI.ts
if (process.env.VITEST !== "true" && process.env.OPENCLAW_SUPPRESS_EXTENSION_API_WARNING !== "1") process.emitWarning("openclaw/extension-api is deprecated. Migrate to api.runtime.agent.* or focused openclaw/plugin-sdk/<subpath> imports. See https://docs.openclaw.ai/plugins/sdk-migration", {
	code: "OPENCLAW_EXTENSION_API_DEPRECATED",
	detail: "This compatibility bridge is temporary. Bundled plugins should use the injected plugin runtime instead of importing host-side agent helpers directly. Migration guide: https://docs.openclaw.ai/plugins/sdk-migration"
});
//#endregion
export { DEFAULT_MODEL, DEFAULT_PROVIDER, ensureAgentWorkspace, loadSessionStore, resolveAgentDir, resolveAgentIdentity, resolveAgentTimeoutMs, resolveAgentWorkspaceDir, resolveSessionFilePath, resolveStorePath, resolveThinkingDefault, runEmbeddedPiAgent, saveSessionStore, updateSessionStore, updateSessionStoreEntry };
