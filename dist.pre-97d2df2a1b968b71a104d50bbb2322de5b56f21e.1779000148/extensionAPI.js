import "./agent-scope-DXGTDSD0.js";
import { a as resolveAgentDir, o as resolveAgentWorkspaceDir } from "./agent-scope-config-DdZBnV-N.js";
import { n as DEFAULT_MODEL, r as DEFAULT_PROVIDER } from "./defaults-D0p0lnLM.js";
import { i as resolveSessionFilePath, u as resolveStorePath } from "./paths-izP4MuZ5.js";
import { t as loadSessionStore } from "./store-load-CYzFXvuT.js";
import { a as saveSessionStore, c as updateSessionStoreEntry, s as updateSessionStore } from "./store-MLsIinKe.js";
import "./sessions-B5_JTnFp.js";
import { m as resolveThinkingDefault } from "./model-selection-BxUseaAH.js";
import { n as resolveAgentIdentity } from "./identity-E3meQIJg.js";
import { l as ensureAgentWorkspace } from "./workspace-CJq22W2D.js";
import { t as resolveAgentTimeoutMs } from "./timeout-BSLFv0Tt.js";
import { t as runEmbeddedPiAgent } from "./pi-embedded-Bf02KguO.js";
//#region src/extensionAPI.ts
if (process.env.VITEST !== "true" && process.env.OPENCLAW_SUPPRESS_EXTENSION_API_WARNING !== "1") process.emitWarning("openclaw/extension-api is deprecated. Migrate to api.runtime.agent.* or focused openclaw/plugin-sdk/<subpath> imports. See https://docs.openclaw.ai/plugins/sdk-migration", {
	code: "OPENCLAW_EXTENSION_API_DEPRECATED",
	detail: "This compatibility bridge is temporary. Bundled plugins should use the injected plugin runtime instead of importing host-side agent helpers directly. Migration guide: https://docs.openclaw.ai/plugins/sdk-migration"
});
//#endregion
export { DEFAULT_MODEL, DEFAULT_PROVIDER, ensureAgentWorkspace, loadSessionStore, resolveAgentDir, resolveAgentIdentity, resolveAgentTimeoutMs, resolveAgentWorkspaceDir, resolveSessionFilePath, resolveStorePath, resolveThinkingDefault, runEmbeddedPiAgent, saveSessionStore, updateSessionStore, updateSessionStoreEntry };
