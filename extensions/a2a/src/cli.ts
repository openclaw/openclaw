/**
 * A2A CLI subcommands — `openclaw a2a <subcommand>`
 *
 * Commands:
 *   status    — show plugin status and Agent Card summary
 *   card      — print the full Agent Card JSON
 *   peers     — list configured peers
 *   discover  — fetch a remote agent's Agent Card
 *   send      — send a message to a remote A2A peer
 *   check     — check health of configured peers
 */

import type { Command } from "commander";
import { buildAgentCard, A2A_PROTOCOL_VERSION } from "./agent-card.js";
import { checkPeerHealth, fetchAgentCard, sendMessageToPeer } from "./client.js";
import type { A2APluginConfig } from "./config.js";

// ── Types ──────────────────────────────────────────────────────────

type Logger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
};

// ── Helpers ────────────────────────────────────────────────────────

/** Print JSON with optional compact mode. */
function printJson(data: unknown, compact: boolean): void {
  console.log(JSON.stringify(data, null, compact ? 0 : 2));
}

/** Format milliseconds into human-readable duration. */
function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

// ── Registration ───────────────────────────────────────────────────

export function registerA2ACli(params: {
  program: Command;
  config: A2APluginConfig;
  logger: Logger;
}): void {
  const { program, config: cfg, logger } = params;

  const root = program
    .command("a2a")
    .description("A2A protocol — cross-network agent-to-agent communication")
    .addHelpText("after", () => "\nDocs: https://docs.openclaw.ai/extensions/a2a\n");

  // ── a2a status ──────────────────────────────────────────────────

  root
    .command("status")
    .description("Show A2A plugin status and Agent Card summary")
    .action(() => {
      console.log("A2A Plugin Status");
      console.log("─".repeat(40));
      console.log(`  Enabled:          ${cfg.enabled ? "✓ yes" : "✗ no"}`);
      console.log(`  Protocol:         A2A v${A2A_PROTOCOL_VERSION}`);
      console.log(`  Agent Name:       ${cfg.card.name}`);
      console.log(`  Agent Version:    ${cfg.card.version}`);
      console.log(`  Auth Mode:        ${cfg.auth.mode}`);
      console.log(`  Auth Token:       ${cfg.auth.token ? "configured" : "not set"}`);
      console.log(`  Default Agent:    ${cfg.routing.defaultAgentId}`);
      console.log(`  Skills:           ${cfg.card.skills.map((s) => s.name).join(", ") || "none"}`);
      console.log(`  Input Modes:      ${cfg.card.defaultInputModes.join(", ")}`);
      console.log(`  Output Modes:     ${cfg.card.defaultOutputModes.join(", ")}`);
      console.log(`  Peers:            ${cfg.peers.length}`);
      console.log(`  Response Timeout: ${formatMs(cfg.timeouts.agentResponseMs)}`);
      console.log(`  Task Retention:   ${formatMs(cfg.timeouts.taskRetentionMs)}`);

      if (cfg.peers.length > 0) {
        console.log("");
        console.log("Configured Peers:");
        for (const p of cfg.peers) {
          const authTag = p.auth ? " [auth]" : "";
          console.log(`  • ${p.name}${authTag}`);
          console.log(`    ${p.agentCardUrl}`);
        }
      }
    });

  // ── a2a card ────────────────────────────────────────────────────

  root
    .command("card")
    .description("Print the full Agent Card JSON")
    .option("--compact", "Print compact JSON (no indentation)", false)
    .action((opts: { compact: boolean }) => {
      // Build the card with a placeholder URL (actual URL depends on runtime gateway port)
      const gatewayUrl = "http://127.0.0.1:18789";
      const card = buildAgentCard(cfg, gatewayUrl);
      printJson(card, opts.compact);
    });

  // ── a2a peers ───────────────────────────────────────────────────

  root
    .command("peers")
    .description("List configured A2A peers")
    .option("--json", "Output as JSON", false)
    .action((opts: { json: boolean }) => {
      if (cfg.peers.length === 0) {
        if (opts.json) {
          console.log("[]");
        } else {
          console.log("No peers configured.");
          console.log("Add peers in config: plugins.entries.a2a.config.peers");
        }
        return;
      }

      if (opts.json) {
        const peers = cfg.peers.map((p) => ({
          name: p.name,
          agentCardUrl: p.agentCardUrl,
          hasAuth: !!p.auth,
        }));
        printJson(peers, false);
        return;
      }

      console.log(`A2A Peers (${cfg.peers.length}):`);
      console.log("─".repeat(60));
      for (const p of cfg.peers) {
        const authTag = p.auth ? " 🔒" : "";
        console.log(`  ${p.name}${authTag}`);
        console.log(`    URL: ${p.agentCardUrl}`);
      }
    });

  // ── a2a discover ────────────────────────────────────────────────

  root
    .command("discover")
    .description("Fetch a remote agent's Agent Card")
    .argument("<target>", "Peer name (from config) or Agent Card URL")
    .option("--compact", "Print compact JSON", false)
    .action(async (target: string, opts: { compact: boolean }) => {
      try {
        // Resolve: peer name or raw URL
        const peer = cfg.peers.find((p) => p.name.toLowerCase() === target.toLowerCase());
        const cardUrl = peer?.agentCardUrl ?? target;

        if (!cardUrl.startsWith("http://") && !cardUrl.startsWith("https://")) {
          if (!peer) {
            console.error(`Error: "${target}" is not a configured peer and not a valid URL.`);
            console.error(`Configured peers: ${cfg.peers.map((p) => p.name).join(", ") || "none"}`);
            process.exitCode = 1;
            return;
          }
        }

        console.error(`Fetching Agent Card from ${cardUrl}...`);
        const card = await fetchAgentCard(cardUrl, peer?.auth);
        printJson(card, opts.compact);
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });

  // ── a2a send ────────────────────────────────────────────────────

  root
    .command("send")
    .description("Send a message to a remote A2A peer")
    .requiredOption("-p, --peer <name>", "Peer name (from config)")
    .requiredOption("-m, --message <text>", "Message to send")
    .option("--agent-id <id>", "Target agent ID on the remote peer")
    .option("--async", "Send non-blocking (returns task ID for polling)", false)
    .option("--timeout <ms>", "Response timeout in milliseconds")
    .option("--json", "Output raw JSON response", false)
    .action(
      async (opts: {
        peer: string;
        message: string;
        agentId?: string;
        async: boolean;
        timeout?: string;
        json: boolean;
      }) => {
        try {
          const peer = cfg.peers.find((p) => p.name.toLowerCase() === opts.peer.toLowerCase());
          if (!peer) {
            console.error(`Error: peer "${opts.peer}" not found in config.`);
            console.error(`Configured peers: ${cfg.peers.map((p) => p.name).join(", ") || "none"}`);
            process.exitCode = 1;
            return;
          }

          const timeoutMs = opts.timeout
            ? parseInt(opts.timeout, 10)
            : cfg.timeouts.agentResponseMs;
          const blocking = !opts.async;

          if (!opts.json) {
            console.error(`Sending to ${peer.name}${blocking ? " (blocking)" : " (async)"}...`);
          }

          const result = await sendMessageToPeer({
            peer,
            message: opts.message,
            agentId: opts.agentId,
            blocking,
            timeoutMs,
          });

          if (opts.json) {
            printJson(result, false);
            return;
          }

          // Human-readable output
          console.log("");
          if (result.taskId) {
            console.log(`Task ID: ${result.taskId}`);
          }
          console.log(`Status:  ${result.status}`);

          if (result.reply) {
            console.log("");
            console.log("Reply:");
            console.log("─".repeat(40));
            console.log(result.reply);
          }

          if (result.error) {
            console.error(`\nError: ${result.error}`);
            process.exitCode = 1;
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error(`[a2a] send failed: ${msg}`);
          console.error(`Error: ${msg}`);
          process.exitCode = 1;
        }
      },
    );

  // ── a2a check ─────────────────────────────────────────────────

  root
    .command("check")
    .description("Check health of configured peers")
    .argument("[name]", "Specific peer to check (checks all if omitted)")
    .option("--json", "Output as JSON", false)
    .action(async (name: string | undefined, opts: { json: boolean }) => {
      const targets = name
        ? cfg.peers.filter((p) => p.name.toLowerCase() === name.toLowerCase())
        : cfg.peers;

      if (targets.length === 0) {
        if (name) {
          console.error(`Error: peer "${name}" not found in config.`);
          console.error(`Configured peers: ${cfg.peers.map((p) => p.name).join(", ") || "none"}`);
        } else {
          console.error("No peers configured.");
        }
        process.exitCode = 1;
        return;
      }

      if (!opts.json) {
        console.error(`Checking ${targets.length} peer(s)...`);
      }

      // Check all peers concurrently
      const results = await Promise.all(targets.map((p) => checkPeerHealth(p)));

      if (opts.json) {
        printJson(results, false);
        return;
      }

      // Human-readable table
      console.log("");
      console.log("Peer Health Check");
      console.log("─".repeat(60));

      for (const r of results) {
        const icon = r.reachable ? "✓" : "✗";
        console.log(`  ${icon} ${r.name} (${r.latencyMs}ms)`);
        if (r.reachable) {
          console.log(`    Agent:    ${r.agentName}`);
          console.log(`    Protocol: ${r.protocolVersion}`);
          console.log(`    Stream:   ${r.streaming ? "yes" : "no"}`);
          if (r.skills && r.skills.length > 0) {
            console.log(`    Skills:   ${r.skills.join(", ")}`);
          }
        } else {
          console.log(`    Error:    ${r.error}`);
        }
      }

      const reachable = results.filter((r) => r.reachable).length;
      console.log("");
      console.log(`${reachable}/${results.length} peers reachable`);

      if (reachable < results.length) {
        process.exitCode = 1;
      }
    });
}
