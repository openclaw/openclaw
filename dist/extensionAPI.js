import { a as resolveAgentDir, o as resolveAgentWorkspaceDir } from "./agent-scope-config-26EcJVc0.js";
import "./agent-scope-C1Fl7gAf.js";
import { n as DEFAULT_MODEL, r as DEFAULT_PROVIDER } from "./defaults-BGwElg4C.js";
import { i as resolveSessionFilePath, u as resolveStorePath } from "./paths-kGAxo7MN.js";
import { t as loadSessionStore } from "./store-load-cmAGD4uk.js";
import { a as saveSessionStore, c as updateSessionStoreEntry, s as updateSessionStore } from "./store-3qAZ3Zl6.js";
import "./sessions-BhOk6siH.js";
import { m as resolveThinkingDefault } from "./model-selection-VRXWv5rs.js";
import { t as resolveAgentTimeoutMs } from "./timeout-B90p_5rC.js";
import { l as ensureAgentWorkspace } from "./workspace-BNTZ_9-b.js";
import { n as resolveAgentIdentity } from "./identity-CRZts9Qd.js";
import { t as runEmbeddedPiAgent } from "./pi-embedded-CPEBK2iK.js";
//#region src/extensionAPI.ts
if (process.env.VITEST !== "true" && process.env.OPENCLAW_SUPPRESS_EXTENSION_API_WARNING !== "1") process.emitWarning("openclaw/extension-api is deprecated. Migrate to api.runtime.agent.* or focused openclaw/plugin-sdk/<subpath> imports. See https://docs.openclaw.ai/plugins/sdk-migration", {
	code: "OPENCLAW_EXTENSION_API_DEPRECATED",
	detail: "This compatibility bridge is temporary. Bundled plugins should use the injected plugin runtime instead of importing host-side agent helpers directly. Migration guide: https://docs.openclaw.ai/plugins/sdk-migration"
});
//#endregion
export { DEFAULT_MODEL, DEFAULT_PROVIDER, ensureAgentWorkspace, loadSessionStore, resolveAgentDir, resolveAgentIdentity, resolveAgentTimeoutMs, resolveAgentWorkspaceDir, resolveSessionFilePath, resolveStorePath, resolveThinkingDefault, runEmbeddedPiAgent, saveSessionStore, updateSessionStore, updateSessionStoreEntry };
