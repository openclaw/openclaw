import type {
  OpenClawPluginApi,
  OpenClawPluginNodeInvokePolicy,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  deleteComputerArmState,
  isArmed,
  readComputerArmState,
  writeComputerArmState,
  type ComputerArmState,
} from "./src/arm-state.js";
import { createLazyComputerTool } from "./src/computer-tool.js";
import { resolveComputerUseConfig } from "./src/config.js";
import { createComputerInputPolicy } from "./src/input-policy.js";

const ARM_STORE_MAX_ENTRIES = 256;
const COMPUTER_ADMIN_SCOPE = "operator.admin";

function createComputerStatusPolicy(): OpenClawPluginNodeInvokePolicy {
  return {
    commands: ["computer.status"],
    defaultPlatforms: ["macos"],
    handle: (ctx) => ctx.invokeNode(),
  };
}

function parseDurationMs(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const match = value
    .trim()
    .toLowerCase()
    .match(/^(\d+)(ms|s|m|h)$/u);
  if (!match) {
    return null;
  }
  const amount = Number.parseInt(match[1] ?? "", 10);
  const unit = match[2];
  const multiplier = unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : 3_600_000;
  const durationMs = amount * multiplier;
  return Number.isSafeInteger(durationMs) && durationMs > 0 ? durationMs : null;
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) {
    return `${durationMs}ms`;
  }
  if (durationMs < 60_000) {
    return `${Math.floor(durationMs / 1000)}s`;
  }
  if (durationMs < 3_600_000) {
    return `${Math.floor(durationMs / 60_000)}m`;
  }
  return `${Math.floor(durationMs / 3_600_000)}h`;
}

function canMutateArmState(ctx: {
  senderIsOwner?: boolean;
  gatewayClientScopes?: readonly string[];
}): boolean {
  if (Array.isArray(ctx.gatewayClientScopes)) {
    return ctx.gatewayClientScopes.includes(COMPUTER_ADMIN_SCOPE);
  }
  return ctx.senderIsOwner === true;
}

function formatArmState(nodeId: string, state: ComputerArmState, nowMs: number): string {
  if (!isArmed(state, nowMs)) {
    return `${nodeId}: disarmed (expired)`;
  }
  const expiry =
    state.expiresAtMs === null
      ? "manual disarm required"
      : `expires in ${formatDuration(state.expiresAtMs - nowMs)}`;
  return `${nodeId}: armed (${expiry})`;
}

function formatHelp(defaultDurationMs: number): string {
  return [
    "Computer control commands:",
    "",
    "/computer status [node-id]",
    "/computer arm <node-id> [duration]",
    "/computer disarm <node-id>",
    "",
    `Duration format: 500ms | 30s | 15m | 2h (default: ${formatDuration(defaultDurationMs)}).`,
    "Arming does not change gateway.nodes.allowCommands; computer.input still requires explicit operator opt-in.",
  ].join("\n");
}

export function registerComputerUsePlugin(api: OpenClawPluginApi): void {
  const config = resolveComputerUseConfig(api.pluginConfig);
  // Plugin state is already scoped by plugin id, so the store namespace only
  // names this plugin's arm-state collection.
  const armStore = api.runtime.state.openKeyedStore<ComputerArmState>({
    namespace: "armed",
    maxEntries: ARM_STORE_MAX_ENTRIES,
  });

  api.registerNodeInvokePolicy(createComputerStatusPolicy());
  api.registerNodeInvokePolicy(createComputerInputPolicy({ armStore, api }));
  api.registerTool(createLazyComputerTool(config));
  api.registerCommand({
    name: "computer",
    description: "Arm, disarm, or inspect macOS computer control.",
    acceptsArgs: true,
    exposeSenderIsOwner: true,
    handler: async (ctx) => {
      const tokens = (ctx.args ?? "").trim().split(/\s+/u).filter(Boolean);
      const action = tokens[0]?.toLowerCase();

      if (!action || action === "help") {
        return { text: formatHelp(config.defaultArmDurationMs) };
      }

      if (action === "status") {
        const requestedNode = tokens[1];
        const nowMs = Date.now();
        if (requestedNode) {
          const state = await readComputerArmState(armStore, requestedNode);
          if (!state) {
            return { text: `${requestedNode}: disarmed` };
          }
          if (!isArmed(state, nowMs)) {
            await deleteComputerArmState(armStore, requestedNode);
          }
          return { text: formatArmState(requestedNode, state, nowMs) };
        }
        const entries = await armStore.entries();
        if (entries.length === 0) {
          return { text: "Computer control: no armed nodes." };
        }
        return {
          text: [
            "Computer control:",
            ...entries.map((entry) => formatArmState(entry.key, entry.value, nowMs)),
          ].join("\n"),
        };
      }

      if (action !== "arm" && action !== "disarm") {
        return { text: formatHelp(config.defaultArmDurationMs) };
      }
      if (!canMutateArmState(ctx)) {
        return { text: "⚠️ /computer arm and disarm require operator.admin." };
      }

      const nodeId = tokens[1]?.trim();
      if (!nodeId) {
        return {
          text: `Usage: /computer ${action} <node-id>${action === "arm" ? " [duration]" : ""}`,
        };
      }

      if (action === "disarm") {
        await deleteComputerArmState(armStore, nodeId);
        return { text: `${nodeId}: disarmed` };
      }

      const durationMs = tokens[2] ? parseDurationMs(tokens[2]) : config.defaultArmDurationMs;
      if (durationMs === null) {
        return { text: "Invalid duration. Use values like 500ms, 30s, 15m, or 2h." };
      }
      const armedAtMs = Date.now();
      const expiresAtMs = armedAtMs + durationMs;
      if (!Number.isSafeInteger(expiresAtMs)) {
        return { text: "Invalid duration. The requested expiry is out of range." };
      }
      await writeComputerArmState(armStore, nodeId, {
        armedAtMs,
        expiresAtMs,
        ...(ctx.senderId ? { armedBy: ctx.senderId } : {}),
      });
      return {
        text:
          `${nodeId}: armed for ${formatDuration(durationMs)}.\n` +
          `To disarm early: /computer disarm ${nodeId}`,
      };
    },
  });
}
