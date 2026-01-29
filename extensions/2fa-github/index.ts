/**
 * GitHub Mobile 2FA Gate Extension
 *
 * Gates sensitive tool calls behind GitHub Mobile push authentication.
 * Users must approve on their phone before the bot can execute file writes,
 * shell commands, or other dangerous operations.
 *
 * Configuration:
 * ```yaml
 * plugins:
 *   2fa-github:
 *     enabled: true
 *     clientId: "Iv1.your_client_id_here"
 *     tokenTtlMinutes: 30
 *     sensitiveTools:
 *       - Bash
 *       - Write
 *       - Edit
 *       - NotebookEdit
 *     gateAllTools: false
 * ```
 *
 * Or via environment variable:
 * ```bash
 * export GITHUB_2FA_CLIENT_ID="Iv1.your_client_id_here"
 * ```
 *
 * GitHub OAuth App Setup:
 * 1. Go to GitHub Settings > Developer Settings > OAuth Apps
 * 2. Click "New OAuth App"
 * 3. Fill in application name and URLs (callback URL not used)
 * 4. IMPORTANT: Check "Enable Device Flow"
 * 5. Copy the Client ID (no secret needed for device flow)
 */

import type { MoltbotPluginApi } from "clawdbot/plugin-sdk";
import { register2FAHook } from "./src/hook.js";
import { twoFactorConfigSchema } from "./src/config.js";

const plugin = {
  id: "2fa-github",
  name: "GitHub Mobile 2FA Gate",
  description: "Gates sensitive tools behind GitHub Mobile push authentication",
  configSchema: twoFactorConfigSchema,

  register(api: MoltbotPluginApi) {
    register2FAHook(api);

    // Register CLI commands for managing 2FA sessions
    api.registerCli(
      ({ program }) => {
        const twofa = program.command("2fa").description("GitHub 2FA gate commands");

        twofa
          .command("status")
          .description("Show 2FA session status")
          .action(async () => {
            const { getStats } = await import("./src/session-store.js");
            const stats = getStats();
            console.log(`Active sessions: ${stats.sessionCount}`);
            console.log(`Pending verifications: ${stats.pendingCount}`);
          });

        twofa
          .command("clear")
          .description("Clear all 2FA sessions")
          .action(async () => {
            const { clearAll } = await import("./src/session-store.js");
            clearAll();
            console.log("All 2FA sessions cleared");
          });
      },
      { commands: ["2fa"] },
    );
  },
};

export default plugin;
