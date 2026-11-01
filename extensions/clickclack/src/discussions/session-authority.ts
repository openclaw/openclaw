import { resolveSessionAgentIdStrict } from "openclaw/plugin-sdk/agent-scope-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { captureSessionEntryCurrentCheckAsync } from "openclaw/plugin-sdk/session-binding-runtime";
import type { CoreConfig } from "../types.js";

/** Retain the session owner's receipt-backed facts until the external effect completes. */
export async function prepareDiscussionSessionEntry(runtime: PluginRuntime, sessionKey: string) {
  // SAFETY: resolving the owner only reads the SDK's schema-validated configuration.
  const config = runtime.config.current() as CoreConfig;
  const agentId = resolveSessionAgentIdStrict({ config, sessionKey });
  return await captureSessionEntryCurrentCheckAsync({
    agentId,
    sessionKey,
    storePath: runtime.agent.session.resolveStorePath(config.session?.store, { agentId }),
    matchGeneration: false,
    fields: ["sessionId", "archivedAt"],
  });
}
