/**
 * VibeClaw — Zero-Config Skill Discovery for OpenClaw
 *
 * Connects OpenClaw to the Vibe Index ecosystem (93,600+ resources).
 * When the AI agent encounters a task it can't handle, VibeClaw searches
 * the Vibe Index catalog and recommends the right skill/plugin/MCP server
 * with a ready-to-use install command.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { VibeIndexClient } from "./src/vibe-index-client.js";
import {
  createSearchTool,
  createInstallTool,
  createTrendingTool,
  createManageTool,
  createAuditTool,
} from "./src/tools.js";
import type { VibeClawConfig } from "./src/tools.js";

const DEFAULT_API_KEY = "vibe_live_84lpwof-e2tSDNdEeZOim7bN";

const vibeClawPlugin = {
  id: "vibeclaw",
  name: "VibeClaw",
  description:
    "Zero-Config skill discovery — search, recommend, and install skills from the Vibe Index ecosystem (93,600+ resources)",
  configSchema: emptyPluginConfigSchema(),

  register(api: OpenClawPluginApi) {
    const pluginConfig = (api.pluginConfig ?? {}) as Record<string, unknown>;
    const apiKey = (pluginConfig.apiKey as string) ?? DEFAULT_API_KEY;
    const client = new VibeIndexClient(apiKey);

    const config: VibeClawConfig = {
      searchOnly: (pluginConfig.searchOnly as boolean) ?? false,
      allowedPublishers: (pluginConfig.allowedPublishers as string[]) ?? null,
    };

    const toolNames = [
      "vibeclaw_search",
      "vibeclaw_install",
      "vibeclaw_trending",
      "vibeclaw_manage",
      "vibeclaw_audit",
    ];

    api.registerTool(
      () => {
        return [
          createSearchTool(client),
          createInstallTool(client, config),
          createTrendingTool(client),
          createManageTool(),
          createAuditTool(client),
        ] as any[];
      },
      { names: toolNames },
    );

    // Inject system prompt context via before_prompt_build hook
    api.on("before_prompt_build", (params) => {
      const searchOnlyNote = config.searchOnly
        ? "\n**Note:** This instance is in search-only mode. vibeclaw_install is disabled."
        : "";
      const allowlistNote = config.allowedPublishers
        ? `\n**Note:** Only skills from these publishers can be installed: ${config.allowedPublishers.join(", ")}`
        : "";

      const vibeClawContext = [
        "",
        "## VibeClaw — Skill Discovery",
        "",
        `You have access to VibeClaw tools that connect to the Vibe Index ecosystem (93,600+ skills, plugins, and MCP servers).${searchOnlyNote}${allowlistNote}`,
        "",
        "**When to use VibeClaw:**",
        "- When you cannot fulfill a user's request because a required skill/tool is not installed",
        "- When the user asks about available tools, trending skills, or recommendations",
        "- When the user wants to install a new capability",
        "",
        "**How to use:**",
        "1. Use `vibeclaw_search` to find relevant skills by describing the capability needed",
        "2. Use `vibeclaw_install` to download and install a skill directly from GitHub into ~/.openclaw/skills/",
        "3. Use `vibeclaw_trending` to show what's popular in the ecosystem",
        "4. Use `vibeclaw_manage` to list or uninstall VibeClaw-installed skills",
        "5. Use `vibeclaw_audit` to re-check installed skills against latest Vibe Index security data",
        "",
        "**Important:** When you cannot handle a request (e.g., 'check my email', 'what's the weather'),",
        "DO NOT just say you can't do it. Instead, use vibeclaw_search to find a skill that can,",
        "then use vibeclaw_install to install it. The skill will be available on next session.",
        "",
      ].join("\n");

      if (params.systemPrompt) {
        params.systemPrompt += vibeClawContext;
      }
    });

    api.logger.info("VibeClaw plugin registered — Vibe Index ecosystem connected");
  },
};

export default vibeClawPlugin;
