import type {
  OpenClawPluginApi,
  OpenClawPluginNodeInvokePolicy,
  OpenClawPluginNodeInvokePolicyContext,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  deleteComputerArmState,
  isArmed,
  readComputerArmState,
  writeComputerArmState,
  type ComputerArmStore,
} from "./arm-state.js";
import { resolveComputerUseConfig, type ComputerInputAction } from "./config.js";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Stringify an untrusted param field for the approval summary without risking `[object Object]`. */
function str(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value) ?? "unknown";
}

function isMacOsPlatform(platform: string | undefined): boolean {
  const normalized = platform?.trim().toLowerCase();
  return normalized === "macos" || normalized === "darwin";
}

function readAction(params: unknown): ComputerInputAction | null {
  const action = asRecord(params).action;
  return typeof action === "string" ? (action as ComputerInputAction) : null;
}

function summarizeAction(params: unknown): string {
  const input = asRecord(params);
  const action = typeof input.action === "string" ? input.action : "unknown action";
  switch (action) {
    case "click":
      return [
        `${str(input.button ?? "left")} click`,
        typeof input.count === "number" ? ` x${input.count}` : "",
        typeof input.x === "number" && typeof input.y === "number"
          ? ` at ${input.x},${input.y}`
          : "",
      ].join("");
    case "move":
      return `move pointer to ${str(input.x)},${str(input.y)}`;
    case "drag":
      return `drag through ${Array.isArray(input.path) ? input.path.length : 0} points`;
    case "scroll":
      return `scroll dx=${str(input.dx ?? 0)}, dy=${str(input.dy ?? 0)}`;
    case "key":
      return `press ${str(input.keys ?? "keys")}`;
    case "keyDown":
    case "keyUp":
      return `${action} ${str(input.key ?? "key")}`;
    case "type":
      return `type ${typeof input.text === "string" ? input.text.length : 0} characters`;
    case "hold":
      return `hold ${str(input.key ?? "key")} for ${str(input.durationMs ?? 0)}ms`;
    case "mouseDown":
    case "mouseUp":
      return `${action} ${str(input.button ?? "left")}`;
    default:
      return action;
  }
}

export function createComputerInputPolicy(input: {
  armStore: ComputerArmStore;
  api: Pick<OpenClawPluginApi, "pluginConfig">;
}): OpenClawPluginNodeInvokePolicy {
  return {
    commands: ["computer.input"],
    dangerous: true,
    async handle(ctx: OpenClawPluginNodeInvokePolicyContext) {
      if (!isMacOsPlatform(ctx.node?.platform)) {
        return {
          ok: false,
          code: "UNSUPPORTED_PLATFORM",
          message: "computer.input is available only on macOS nodes",
          unavailable: true,
        };
      }

      const config = resolveComputerUseConfig(ctx.pluginConfig ?? input.api.pluginConfig);
      const action = readAction(ctx.params);
      if (config.allowActions && (!action || !config.allowActions.has(action))) {
        return {
          ok: false,
          code: "ACTION_NOT_ALLOWED",
          message: `computer.input action ${action ?? "unknown"} is not allowed by plugin config`,
        };
      }

      const nowMs = Date.now();
      const armState = await readComputerArmState(input.armStore, ctx.nodeId);
      if (isArmed(armState, nowMs)) {
        return await ctx.invokeNode();
      }
      if (armState) {
        await deleteComputerArmState(input.armStore, ctx.nodeId);
      }

      if (!ctx.approvals) {
        return {
          ok: false,
          code: "APPROVAL_DENIED",
          message: "computer.input requires an armed node or operator approval",
        };
      }

      const nodeName = ctx.node?.displayName ?? ctx.nodeId;
      const approvalContext = ctx as OpenClawPluginNodeInvokePolicyContext & {
        toolCallId?: string;
        agentId?: string;
        sessionKey?: string;
      };
      const approval = await ctx.approvals.request({
        title: "Computer control",
        description: `Allow computer control on ${nodeName}: ${summarizeAction(ctx.params)}`,
        severity: "critical",
        toolName: "computer",
        toolCallId: approvalContext.toolCallId,
        agentId: approvalContext.agentId,
        sessionKey: approvalContext.sessionKey,
        timeoutMs: ctx.timeoutMs,
      });
      if (approval.decision !== "allow-once" && approval.decision !== "allow-always") {
        return {
          ok: false,
          code: "APPROVAL_DENIED",
          message:
            approval.decision === "deny"
              ? "computer.input was denied by the operator"
              : "computer.input approval was not granted",
        };
      }

      if (approval.decision === "allow-always") {
        const armedAtMs = Date.now();
        const expiresAtMs = armedAtMs + config.defaultArmDurationMs;
        if (!Number.isSafeInteger(expiresAtMs)) {
          return {
            ok: false,
            code: "INVALID_CONFIG",
            message: "computer-use defaultArmDurationMs produces an invalid expiry",
          };
        }
        await writeComputerArmState(input.armStore, ctx.nodeId, {
          armedAtMs,
          expiresAtMs,
          ...(ctx.client?.connId ? { armedBy: ctx.client.connId } : {}),
        });
      }

      return await ctx.invokeNode();
    },
  };
}
