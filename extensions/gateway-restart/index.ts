import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import type { Static } from "@sinclair/typebox";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

/**
 * ## Security Considerations
 *
 * - **Shell command execution:** The tool runs commands from a plugin-config-defined
 *   allowlist. Agents cannot specify arbitrary commands — only commands explicitly
 *   listed in `config.allowedCommands` are permitted.
 *
 * - **Process termination:** `process.exit(0)` terminates the entire gateway process,
 *   disconnecting all active sessions — not just the requesting agent. This is
 *   intentional: the gateway restart is a global operation.
 *
 * - **Opt-in only:** The plugin is disabled by default (`enabledByDefault: false`
 *   in the manifest). Operators must explicitly enable it via
 *   `plugins.entries.gateway-restart.enabled: true`.
 *
 * - **Marker file contents:** The restart marker contains the session key and
 *   optional message text. No credentials, API keys, or sensitive data are persisted.
 *
 * - **Followup turn trust level:** Plugin-initiated followup turns run with
 *   `senderIsOwner: true`, establishing trusted execution context. This matches
 *   the trust model for system-initiated turns (heartbeats, cron).
 */

type PluginConfig = {
  allowedCommands?: string[];
  markerFileName?: string;
};

const gatewayRestartParameters = Type.Object({
  sessionKey: Type.String({
    description: "Session key that should receive the post-restart callback event.",
  }),
  commands: Type.Optional(
    Type.Array(Type.String(), {
      description: "Optional allowlisted commands to execute before restart.",
    }),
  ),
  reason: Type.Optional(
    Type.String({
      description: "Optional reason for logging and restart marker metadata.",
    }),
  ),
  message: Type.Optional(
    Type.String({
      description: "Optional message to include in the post-restart callback event.",
    }),
  ),
});

type GatewayRestartParams = Static<typeof gatewayRestartParameters>;

type RestartMarker = {
  sessionKey: string;
  requestedAt: string;
  preCommands: string[];
  reason?: string;
  message?: string;
};

function resolveConfig(input: unknown): Required<PluginConfig> {
  const raw = (input ?? {}) as PluginConfig;
  return {
    allowedCommands: raw.allowedCommands ?? ["openclaw gateway install --force"],
    markerFileName: raw.markerFileName ?? "restart-pending.json",
  };
}

function getMarkerPath(stateDir: string, markerFileName: string): string {
  return path.join(stateDir, markerFileName);
}

export default definePluginEntry({
  id: "gateway-restart",
  name: "Gateway Restart",
  description: "Agent-initiated gateway restart with post-restart session callback.",
  register(api) {
    const config = resolveConfig(api.pluginConfig);
    // Fix 4 & 5: local const, type inferred from SDK (no module-level let, no manual FollowupRuntime type)
    const followupRuntime = api.runtime.followup;
    const stateDir = api.runtime.state.resolveStateDir();

    api.registerTool({
      name: "gateway_restart",
      label: "Gateway Restart",
      description:
        "Restart the current OpenClaw gateway process, optionally run allowlisted commands first, and deliver a completion callback to the provided session.",
      parameters: gatewayRestartParameters,
      async execute(_toolCallId, params) {
        const parsed = params as GatewayRestartParams;
        const commands = parsed.commands ?? [];
        const allowedCommands = new Set(config.allowedCommands);

        if (commands.length > 0 && allowedCommands.size === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: "ERROR: Pre-restart commands are disabled by plugin configuration.",
              },
            ],
            details: null,
          };
        }

        for (const command of commands) {
          if (!allowedCommands.has(command)) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `ERROR: Command not allowed: ${command}`,
                },
              ],
              details: null,
            };
          }
        }

        const markerPath = getMarkerPath(stateDir, config.markerFileName);

        const marker: RestartMarker = {
          sessionKey: parsed.sessionKey,
          requestedAt: new Date().toISOString(),
          preCommands: commands,
          reason: parsed.reason,
          message: parsed.message,
        };

        // Execute pre-commands BEFORE writing marker.
        // If any command fails, we return a structured error and never write the marker.
        const commandOutputs: string[] = [];
        try {
          for (const command of commands) {
            const output = execSync(command, {
              encoding: "utf8",
              timeout: 5 * 60 * 1000, // 5-minute hard cap per command
              stdio: ["ignore", "pipe", "pipe"],
            });
            commandOutputs.push(output);
          }
        } catch (err) {
          return {
            content: [
              {
                type: "text" as const,
                text: `ERROR: Pre-restart command failed: ${String(err instanceof Error ? err.message : err)}`,
              },
            ],
            details: null,
          };
        }

        // Fix 1: Write marker only after all pre-commands succeed.
        fs.mkdirSync(path.dirname(markerPath), { recursive: true });
        fs.writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`, "utf8");

        setTimeout(() => process.exit(0), 500);

        const outputSuffix =
          commandOutputs.length > 0
            ? `\n\nCommand output:\n${commandOutputs
                .map((output, index) => `#${index + 1}\n${output.trim() || "(no output)"}`)
                .join("\n\n")}`
            : "";

        return {
          content: [
            {
              type: "text" as const,
              text:
                `Gateway restart initiated. Pre-commands executed: ${commands.length}. ` +
                "You will receive a callback when the gateway is back online." +
                outputSuffix,
            },
          ],
          details: null,
        };
      },
    });

    api.registerService({
      id: "gateway-restart-watcher",
      async start(ctx) {
        const markerPath = getMarkerPath(ctx.stateDir, config.markerFileName);

        if (!fs.existsSync(markerPath)) {
          return;
        }

        let marker: RestartMarker;
        try {
          marker = JSON.parse(fs.readFileSync(markerPath, "utf8")) as RestartMarker;
        } catch (error) {
          ctx.logger.error(
            `[gateway-restart] Failed to read restart marker ${markerPath}: ${String(error)}`,
          );
          return;
        }

        const requestedAtMs = Date.parse(marker.requestedAt);
        const durationSeconds = Number.isFinite(requestedAtMs)
          ? ((Date.now() - requestedAtMs) / 1000).toFixed(1)
          : "unknown";
        const completionText =
          `[gateway-restart] Gateway restart complete (took ${durationSeconds}s). ${marker.message ?? ""}`.trim();

        // Fix 2: Enqueue first, then conditionally delete marker.
        const enqueued = await followupRuntime.enqueueFollowupTurn({
          sessionKey: marker.sessionKey,
          prompt: `${completionText} Continue with any remaining work.`,
          source: "gateway-restart",
        });

        if (enqueued) {
          // Fix 2: Only delete marker after successful enqueue.
          fs.rmSync(markerPath, { force: true });
          ctx.logger.info(
            `[gateway-restart] Enqueued followup turn for session ${marker.sessionKey}.`,
          );
        } else {
          ctx.logger.warn(
            `[gateway-restart] Failed to enqueue followup turn for session ${marker.sessionKey} (session not found or deduped). Marker preserved for retry on next restart.`,
          );
          // Leave marker on disk so the next restart attempt can retry.
        }
      },
    });
  },
});
