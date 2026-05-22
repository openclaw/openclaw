import { a as resolveAgentDir, o as resolveAgentWorkspaceDir } from "./agent-scope-config-bmagiEt7.js";
import "./agent-scope-BnhYEQue.js";
import { n as DEFAULT_MODEL, r as DEFAULT_PROVIDER } from "./defaults-kkxFBlxd.js";
import { i as resolveSessionFilePath, u as resolveStorePath } from "./paths-BnX-evip.js";
import { t as loadSessionStore } from "./store-load-Dl9FHzUQ.js";
import { a as saveSessionStore, c as updateSessionStoreEntry, s as updateSessionStore } from "./store-DjyTbZFp.js";
import "./sessions-DgIxQTHN.js";
import { m as resolveThinkingDefault } from "./model-selection-DmMcdmk8.js";
import { l as ensureAgentWorkspace } from "./workspace-DNXfPZMj.js";
import { n as resolveAgentIdentity } from "./identity-CuUMUoav.js";
import { t as resolveAgentTimeoutMs } from "./timeout-Dq4lLlo9.js";
import { t as runEmbeddedPiAgent } from "./pi-embedded-KrBNWJMG.js";
//#region src/extensionAPI.ts
if (process.env.VITEST !== "true" && process.env.OPENCLAW_SUPPRESS_EXTENSION_API_WARNING !== "1") process.emitWarning("openclaw/extension-api is deprecated. Migrate to api.runtime.agent.* or focused openclaw/plugin-sdk/<subpath> imports. See https://docs.openclaw.ai/plugins/sdk-migration", {
	code: "OPENCLAW_EXTENSION_API_DEPRECATED",
	detail: "This compatibility bridge is temporary. Bundled plugins should use the injected plugin runtime instead of importing host-side agent helpers directly. Migration guide: https://docs.openclaw.ai/plugins/sdk-migration"
});
//#endregion
export { DEFAULT_MODEL, DEFAULT_PROVIDER, ensureAgentWorkspace, loadSessionStore, resolveAgentDir, resolveAgentIdentity, resolveAgentTimeoutMs, resolveAgentWorkspaceDir, resolveSessionFilePath, resolveStorePath, resolveThinkingDefault, runEmbeddedPiAgent, saveSessionStore, updateSessionStore, updateSessionStoreEntry };
