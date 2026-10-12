import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolvePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

function readExcludeNativeMemory(config: OpenClawConfig | undefined): unknown {
  return asOptionalRecord(resolvePluginConfigObject(config, "anthropic")?.claudeCli)
    ?.excludeNativeMemory;
}

/**
 * Claude Code's own CLAUDE.md files and auto memory stay out of claude-cli agent
 * turns unless the operator sets `claudeCli.excludeNativeMemory: false`; OpenClaw's
 * workspace instructions and memory are the agent's single source.
 */
export function excludesClaudeNativeMemory(config: OpenClawConfig | undefined): boolean {
  return readExcludeNativeMemory(config) !== false;
}

/**
 * True while the exclusion applies only because the option is unset. Setting it either
 * way records the operator's decision, so Doctor stops reminding about memory left in
 * Claude Code.
 */
export function excludesClaudeNativeMemoryByDefault(config: OpenClawConfig | undefined): boolean {
  return typeof readExcludeNativeMemory(config) !== "boolean";
}
