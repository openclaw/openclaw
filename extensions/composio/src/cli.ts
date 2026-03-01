import type { Command } from "commander";
import type { ComposioClient } from "./client.js";
import type { ComposioConfig } from "./types.js";

interface PluginLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

interface RegisterCliOptions {
  program: Command;
  client: ComposioClient;
  config: ComposioConfig;
  logger: PluginLogger;
}

/**
 * Register Composio CLI commands
 */
export function registerComposioCli({ program, client, config, logger }: RegisterCliOptions) {
  const composio = program
    .command("composio")
    .description("Manage Composio Tool Router connections");

  // clawdbot composio list
  composio
    .command("list")
    .description("List available Composio toolkits")
    .action(async () => {
      if (!config.enabled) {
        logger.error("Composio plugin is disabled");
        return;
      }

      try {
        const toolkits = await client.listToolkits();
        console.log("\nAvailable Composio Toolkits:");
        console.log("─".repeat(40));
        for (const toolkit of toolkits.sort()) {
          console.log(`  ${toolkit}`);
        }
        console.log(`\nTotal: ${toolkits.length} toolkits`);
      } catch (err) {
        logger.error(
          `Failed to list toolkits: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });

  // clawdbot composio status [toolkit]
  composio
    .command("status [toolkit]")
    .description("Check connection status for toolkits")
    .option("-u, --user-id <userId>", "User ID for session scoping")
    .action(async (toolkit: string | undefined, options: { userId?: string }) => {
      if (!config.enabled) {
        logger.error("Composio plugin is disabled");
        return;
      }

      try {
        const toolkits = toolkit ? [toolkit] : undefined;
        const statuses = await client.getConnectionStatus(toolkits, options.userId);

        console.log("\nComposio Connection Status:");
        console.log("─".repeat(40));

        if (statuses.length === 0) {
          console.log("  No connections found");
        } else {
          for (const status of statuses) {
            const icon = status.connected ? "✓" : "✗";
            const state = status.connected ? "connected" : "not connected";
            console.log(`  ${icon} ${status.toolkit}: ${state}`);
          }
        }
        console.log();
      } catch (err) {
        logger.error(`Failed to get status: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

  // clawdbot composio connect <toolkit>
  composio
    .command("connect <toolkit>")
    .description("Connect to a Composio toolkit (opens auth URL)")
    .option("-u, --user-id <userId>", "User ID for session scoping")
    .action(async (toolkit: string, options: { userId?: string }) => {
      if (!config.enabled) {
        logger.error("Composio plugin is disabled");
        return;
      }

      try {
        console.log(`\nInitiating connection to ${toolkit}...`);

        const result = await client.createConnection(toolkit, options.userId);

        if ("error" in result) {
          logger.error(`Failed to create connection: ${result.error}`);
          return;
        }

        console.log("\nAuth URL generated:");
        console.log("─".repeat(40));
        console.log(result.authUrl);
        console.log("\nOpen this URL in your browser to authenticate.");
        console.log("After authentication, run 'clawdbot composio status' to verify.\n");

        // Try to open URL in browser
        try {
          // Validate URL is http/https before passing to the OS opener
          const parsed = new URL(result.authUrl);
          if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            throw new Error("Auth URL must use http or https");
          }
          const { spawn } = await import("node:child_process");
          const platform = process.platform;
          const [bin, ...args] =
            platform === "darwin"
              ? (["open", result.authUrl] as const)
              : platform === "win32"
                ? (["cmd", "/c", "start", "", result.authUrl] as const)
                : (["xdg-open", result.authUrl] as const);
          spawn(bin, args, { detached: true, stdio: "ignore" }).unref();
        } catch (err) {
          const url = result.authUrl;
          const reason = err instanceof Error ? err.message : String(err);
          logger.warn(`Could not open browser for auth URL: ${url} — ${reason}`);
        }
      } catch (err) {
        logger.error(`Failed to connect: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

  // clawdbot composio disconnect <toolkit>
  composio
    .command("disconnect <toolkit>")
    .description("Disconnect from a Composio toolkit")
    .option("-u, --user-id <userId>", "User ID for session scoping")
    .action(async (toolkit: string, options: { userId?: string }) => {
      if (!config.enabled) {
        logger.error("Composio plugin is disabled");
        return;
      }

      try {
        console.log(`\nDisconnecting from ${toolkit}...`);

        const result = await client.disconnectToolkit(toolkit, options.userId);

        if (result.success) {
          console.log(`Successfully disconnected from ${toolkit}\n`);
        } else {
          logger.error(`Failed to disconnect: ${result.error}`);
        }
      } catch (err) {
        logger.error(`Failed to disconnect: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

  // clawdbot composio search <query>
  composio
    .command("search <query>")
    .description("Search for tools matching a query")
    .option("-t, --toolkit <toolkit>", "Limit search to a specific toolkit")
    .option("-l, --limit <limit>", "Maximum results", "10")
    .option("-u, --user-id <userId>", "User ID for session scoping")
    .action(
      async (query: string, options: { toolkit?: string; limit: string; userId?: string }) => {
        if (!config.enabled) {
          logger.error("Composio plugin is disabled");
          return;
        }

        try {
          const limit = parseInt(options.limit, 10) || 10;
          const toolkits = options.toolkit ? [options.toolkit] : undefined;

          const results = await client.searchTools(query, {
            toolkits,
            limit,
            userId: options.userId,
          });

          console.log(`\nSearch results for "${query}":`);
          console.log("─".repeat(60));

          if (results.length === 0) {
            console.log("  No tools found matching your query");
          } else {
            for (const tool of results) {
              console.log(`\n  ${tool.slug}`);
              console.log(`    Toolkit: ${tool.toolkit}`);
              console.log(
                `    ${tool.description.slice(0, 100)}${tool.description.length > 100 ? "..." : ""}`,
              );
            }
          }
          console.log(`\nTotal: ${results.length} tools found\n`);
        } catch (err) {
          logger.error(`Failed to search: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    );
}
