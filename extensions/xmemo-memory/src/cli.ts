// XMemo plugin CLI commands.

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { XMemoClient } from "./client.js";
import { resolveXMemoMemoryConfig } from "./config.js";
import { XMemoSearchManager } from "./search-manager.js";

export function registerXMemoCli(api: OpenClawPluginApi): void {
  api.registerCli(
    ({ program }) => {
      const xmemo = program.command("xmemo").description("XMemo cloud memory commands");

      xmemo
        .command("status")
        .description("Show XMemo memory backend status")
        .option("--json", "Output machine-readable JSON")
        .action(async (opts) => {
          const cfg = resolveXMemoMemoryConfig(api.config);
          const configured = Boolean(cfg.apiKey);

          let connected = false;
          let lastError: string | undefined;

          if (configured) {
            const client = new XMemoClient(
              cfg.baseUrl,
              cfg.apiKey!,
              cfg.agentId,
              cfg.agentInstanceId,
              cfg.authMode,
            );
            const manager = new XMemoSearchManager(client, cfg);
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 10_000);
            try {
              connected = await manager.probeConnectivity(controller.signal);
            } finally {
              clearTimeout(timeout);
            }
            const status = manager.status();
            if (status.custom && typeof status.custom.lastError === "string") {
              lastError = status.custom.lastError;
            }
          }

          const status = {
            backend: "xmemo",
            provider: "xmemo-memory",
            configured,
            connected,
            baseUrl: cfg.baseUrl,
            bucket: cfg.bucket,
            scope: cfg.scope,
            teamId: cfg.teamId,
            agentId: cfg.agentId,
            agentInstanceId: cfg.agentInstanceId,
            autoCapture: cfg.autoCapture,
            ...(lastError ? { lastError } : {}),
          };

          if (opts.json) {
            console.log(JSON.stringify(status, null, 2));
          } else {
            console.log(`XMemo memory backend: ${configured ? "configured" : "not configured"}`);
            console.log(`  Connected: ${connected ? "yes" : "no"}`);
            console.log(`  Base URL: ${status.baseUrl}`);
            console.log(`  Bucket: ${status.bucket}`);
            if (status.scope) {
              console.log(`  Scope: ${status.scope}`);
            }
            if (status.teamId) {
              console.log(`  Team: ${status.teamId}`);
            }
            console.log(`  Agent: ${status.agentId}`);
            console.log(`  Auto capture: ${status.autoCapture}`);
            if (lastError) {
              console.log(`  Last error: ${lastError}`);
            }
          }
        });
    },
    { parentPath: ["memory"], commands: ["xmemo"] },
  );
}
