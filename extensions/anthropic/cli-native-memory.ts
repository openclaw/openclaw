import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolvePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

/**
 * Claude Code's own CLAUDE.md files and auto memory stay out of claude-cli agent
 * turns unless the operator sets `claudeCli.excludeNativeMemory: false`; OpenClaw's
 * workspace instructions and memory are the agent's single source.
 */
export function excludesClaudeNativeMemory(config: OpenClawConfig | undefined): boolean {
  const claudeCli = asOptionalRecord(resolvePluginConfigObject(config, "anthropic")?.claudeCli);
  return claudeCli?.excludeNativeMemory !== false;
}
