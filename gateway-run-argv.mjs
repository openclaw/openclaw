// Startup-safe Gateway command-role parsing, shared with the CLI.
import { getCommandPositionalsWithRootOptions } from "./cli-root-options.mjs";

export const GATEWAY_RUN_VALUE_FLAGS = new Set([
  "--port",
  "--bind",
  "--token",
  "--token-file",
  "--auth",
  "--password",
  "--password-file",
  "--tailscale",
  "--ws-log",
  "--raw-stream-path",
]);

export const GATEWAY_RUN_BOOLEAN_FLAGS = new Set([
  "--tailscale-reset-on-exit",
  "--allow-unconfigured",
  "--dev",
  "--ambient-channels",
  "--dev-ambient-channels",
  "--reset",
  "--update-canary",
  "--force",
  "--verbose",
  "--cli-backend-logs",
  "--claude-cli-logs",
  "--compact",
  "--raw-stream",
]);

export function isForegroundGatewayRunArgv(argv) {
  const positionals = getCommandPositionalsWithRootOptions(argv, {
    commandPath: ["gateway"],
    // Service supervision still owns a long-lived Gateway. Keep these flags out
    // of the fast-path option sets: supervisor commands need full CLI parsing.
    booleanFlags: [...GATEWAY_RUN_BOOLEAN_FLAGS, "--task-supervisor"],
    valueFlags: [...GATEWAY_RUN_VALUE_FLAGS, "--task-supervisor-child"],
    mode: "command-path",
  });
  if (!positionals) {
    return false;
  }
  // Foreground gateway owns the terminal/process environment itself; respawning would
  // add an extra parent process around the long-lived server.
  return positionals.length === 0 || (positionals.length === 1 && positionals[0] === "run");
}
