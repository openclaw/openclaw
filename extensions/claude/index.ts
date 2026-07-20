/**
 * Claude extension entry point. Registers the claude-bridge AgentHarness
 * for the `anthropic` provider so OpenClaw can delegate Claude turns to a
 * local @zeroaltitude/openclaw-claude-bridge process (the Anthropic analog of the
 * codex-app-server pattern).
 *
 * The harness factory itself lives in harness.ts; runtime is in
 * src/app-server/run-attempt.ts and is dynamic-imported to keep the entry
 * point lazy.
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveLivePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createClaudeAppServerAgentHarness } from "./harness.js";
import { registerClaudeSessionsPanel } from "./src/app-server/sessions-panel.js";
import { createClaudeCommand } from "./src/commands.js";

export default definePluginEntry({
  id: "claude",
  name: "Claude",
  description:
    "Claude app-server harness — delegates Anthropic turns to @zeroaltitude/openclaw-claude-bridge.",
  register(api) {
    const resolveCurrentPluginConfig = () =>
      resolveLivePluginConfigObject(
        api.runtime.config?.current
          ? () => api.runtime.config.current() as OpenClawConfig
          : undefined,
        "claude",
        api.pluginConfig as Record<string, unknown>,
      ) ?? api.pluginConfig;
    api.registerAgentHarness(
      createClaudeAppServerAgentHarness({ resolvePluginConfig: resolveCurrentPluginConfig }),
    );
    api.registerCommand(
      createClaudeCommand({
        pluginConfig: api.pluginConfig,
        resolvePluginConfig: resolveCurrentPluginConfig,
      }),
    );
    registerClaudeSessionsPanel(api);
  },
});
