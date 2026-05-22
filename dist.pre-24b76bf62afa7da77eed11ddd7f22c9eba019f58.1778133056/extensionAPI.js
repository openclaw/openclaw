import { b as resolveAgentDir, x as resolveAgentWorkspaceDir } from "./agent-scope-eOlEQiLx.js";
import { n as DEFAULT_MODEL, r as DEFAULT_PROVIDER } from "./defaults-DadkqTRx.js";
import { i as resolveSessionFilePath, u as resolveStorePath } from "./paths-CEC5JHmb.js";
import { t as loadSessionStore } from "./store-load-u3EktAq0.js";
import { i as saveSessionStore, o as updateSessionStore, s as updateSessionStoreEntry } from "./store-DypV6NYF.js";
import "./sessions-CiMlHWga.js";
import { p as resolveThinkingDefault } from "./model-selection-BP-YASdB.js";
import { l as ensureAgentWorkspace } from "./workspace-Dxkfjv2N.js";
import { n as resolveAgentIdentity } from "./identity-BtZhHHvn.js";
import { t as resolveAgentTimeoutMs } from "./timeout-DX3hMkne.js";
import { t as runEmbeddedPiAgent } from "./pi-embedded-BXV_7L-Q.js";
//#region src/extensionAPI.ts
if (process.env.VITEST !== "true" && process.env.OPENCLAW_SUPPRESS_EXTENSION_API_WARNING !== "1") process.emitWarning("openclaw/extension-api is deprecated. Migrate to api.runtime.agent.* or focused openclaw/plugin-sdk/<subpath> imports. See https://docs.openclaw.ai/plugins/sdk-migration", {
	code: "OPENCLAW_EXTENSION_API_DEPRECATED",
	detail: "This compatibility bridge is temporary. Bundled plugins should use the injected plugin runtime instead of importing host-side agent helpers directly. Migration guide: https://docs.openclaw.ai/plugins/sdk-migration"
});
//#endregion
export { DEFAULT_MODEL, DEFAULT_PROVIDER, ensureAgentWorkspace, loadSessionStore, resolveAgentDir, resolveAgentIdentity, resolveAgentTimeoutMs, resolveAgentWorkspaceDir, resolveSessionFilePath, resolveStorePath, resolveThinkingDefault, runEmbeddedPiAgent, saveSessionStore, updateSessionStore, updateSessionStoreEntry };
