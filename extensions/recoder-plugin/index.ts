/**
 * Recoder Plugin for OpenClaw
 *
 * Enables OpenClaw agents (WhatsApp, Telegram, Discord, etc.) to:
 * - Create and manage Recoder projects
 * - Generate code via AI
 * - Manage Docker sandbox containers
 * - Read/write files
 * - Execute shell commands
 * - Get live preview URLs
 *
 * @see https://recoder.xyz
 */

import type { OpenClawPluginApi } from "../../src/plugins/types.js";

import { createRecoderProjectTool } from "./src/tools/recoder-project.js";
import { createRecoderCodeTool } from "./src/tools/recoder-code.js";
import { createRecoderSandboxTool } from "./src/tools/recoder-sandbox.js";
import { createRecoderFilesTool } from "./src/tools/recoder-files.js";
import { createRecoderShellTool } from "./src/tools/recoder-shell.js";
import { createRecoderPreviewTool } from "./src/tools/recoder-preview.js";

import { loadSessionState, saveSessionState } from "./src/services/session-state.js";
import { runSetupWizard, loadCredentials, verifyCredentials } from "./src/cli/setup.js";
import { getOrCreateApiKey, clearApiKeyCache } from "./src/services/api-key-manager.js";
import type { RecoderPluginConfig } from "./src/types/index.js";

export default function register(api: OpenClawPluginApi) {
  api.logger.info("Recoder plugin initializing...");

  const config = (api.pluginConfig ?? {}) as RecoderPluginConfig;

  // Register all tools with API key context injection
  api.registerTool(createRecoderProjectTool(api), {
    name: "recoder_project",
    optional: true,
  });

  api.registerTool(createRecoderCodeTool(api), {
    name: "recoder_code",
    optional: true,
  });

  api.registerTool(createRecoderSandboxTool(api), {
    name: "recoder_sandbox",
    optional: true,
  });

  api.registerTool(createRecoderFilesTool(api), {
    name: "recoder_files",
    optional: true,
  });

  api.registerTool(createRecoderShellTool(api), {
    name: "recoder_shell",
    optional: true,
  });

  api.registerTool(createRecoderPreviewTool(api), {
    name: "recoder_preview",
    optional: true,
  });

  // Register session lifecycle hooks to persist state and manage API keys
  api.on("session_start", async (_event, ctx) => {
    try {
      await loadSessionState();
      api.logger.debug("Recoder session state loaded");

      // Auto-provision API key for this user if needed
      if (ctx.agentId && !config.apiKey) {
        // Extract channel from context, fall back to "openclaw" if not available
        // Channel could be: telegram, whatsapp, discord, slack, signal, etc.
        const channel = (ctx as any).messageChannel || (ctx as any).channel || "openclaw";
        try {
          const { apiKey, isNew } = await getOrCreateApiKey(config, ctx.agentId, channel);
          if (isNew) {
            api.logger.info(`Created new Recoder API key for agent ${ctx.agentId} on channel ${channel}`);
          }
          // Update config with the API key for this session
          (api.pluginConfig as RecoderPluginConfig).apiKey = apiKey;
        } catch (err) {
          api.logger.warn(`Failed to provision Recoder API key: ${err}`);
        }
      }
    } catch (err) {
      api.logger.warn(`Failed to load Recoder session state: ${err}`);
    }
  });

  api.on("after_tool_call", async (event, _ctx) => {
    // Persist state after any recoder tool call
    if (event.toolName?.startsWith("recoder_")) {
      try {
        const state = await loadSessionState();
        await saveSessionState(state);
      } catch (err) {
        api.logger.warn(`Failed to save Recoder session state: ${err}`);
      }
    }
  });

  // Register CLI commands
  api.registerCli(({ program, logger }) => {
    program
      .command("recoder:setup")
      .description("Configure Recoder.xyz credentials")
      .action(async () => {
        try {
          await runSetupWizard();
        } catch (err) {
          logger.error(`Setup failed: ${err}`);
          process.exit(1);
        }
      });

    program
      .command("recoder:status")
      .description("Check Recoder connection status")
      .action(async () => {
        const creds = await loadCredentials();
        if (!creds) {
          logger.error("No Recoder credentials configured. Run: openclaw recoder:setup");
          process.exit(1);
        }

        logger.info("Checking Recoder connections...");
        const result = await verifyCredentials(creds);

        console.log("");
        console.log(`Recoder Web: ${result.webOk ? "✅ OK" : "❌ Failed"}`);
        console.log(`Docker Backend: ${result.dockerOk ? "✅ OK" : "❌ Failed"}`);
        console.log(`API Backend: ${result.apiOk ? "✅ OK" : "❌ Failed"}`);

        if (result.errors.length > 0) {
          console.log("\nErrors:");
          for (const err of result.errors) {
            console.log(`  - ${err}`);
          }
        }

        process.exit(result.valid ? 0 : 1);
      });

    program
      .command("recoder:clear-keys")
      .description("Clear cached API keys (forces regeneration)")
      .action(async () => {
        try {
          await clearApiKeyCache();
          logger.info("API key cache cleared. New keys will be generated on next use.");
        } catch (err) {
          logger.error(`Failed to clear API key cache: ${err}`);
          process.exit(1);
        }
      });
  }, { commands: ["recoder:setup", "recoder:status", "recoder:clear-keys"] });

  api.logger.info("Recoder plugin registered 6 tools: recoder_project, recoder_code, recoder_sandbox, recoder_files, recoder_shell, recoder_preview");
}
