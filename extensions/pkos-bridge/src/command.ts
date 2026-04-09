import type { OpenClawPluginApi } from "../api.js";
import type { ResolvedPkosBridgeConfig } from "./config.js";
import { buildBridgeStatusText } from "./shared.js";

export function createPkosBridgeCommand(
  config: ResolvedPkosBridgeConfig,
): Parameters<OpenClawPluginApi["registerCommand"]>[0] {
  return {
    name: "pkos-bridge",
    description: "Inspect the PKOS bridge scaffold and planned integration surfaces.",
    acceptsArgs: true,
    requireAuth: true,
    async handler(ctx) {
      const subcommand = ctx.args?.trim().toLowerCase() || "status";
      if (subcommand === "status") {
        return { text: buildBridgeStatusText(config) };
      }

      return {
        text: [
          `Unknown pkos-bridge subcommand: ${subcommand}`,
          "Supported subcommands:",
          "- status",
        ].join("\n"),
      };
    },
  };
}
