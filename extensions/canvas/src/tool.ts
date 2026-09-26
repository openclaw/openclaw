import { randomUUID } from "node:crypto";
import { callGatewayTool, listNodes } from "openclaw/plugin-sdk/agent-harness-runtime";
import { jsonResult, readStringParam } from "openclaw/plugin-sdk/channel-actions";
import {
  addTimerTimeoutGraceMs,
  clampPositiveTimerTimeoutMs,
} from "openclaw/plugin-sdk/number-runtime";
import { readFiniteNumberParam, readPositiveIntegerParam } from "openclaw/plugin-sdk/param-readers";
import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { CANVAS_PRESENT_COMMAND, resolveCanvasNodeFromList } from "./node-eligibility.js";
import { canvasToolDefinition } from "./tool-schema.js";

type CanvasToolOptions = {
  agentSessionKey?: string;
};

const DEFAULT_CANVAS_NODE_INVOKE_TIMEOUT_MS = 30_000;
const CANVAS_NODE_INVOKE_TRANSPORT_GRACE_MS = 10_000;

function readGatewayCallOptions(params: Record<string, unknown>) {
  return {
    gatewayUrl: readStringParam(params, "gatewayUrl", { trim: false }),
    gatewayToken: readStringParam(params, "gatewayToken", { trim: false }),
    timeoutMs: readPositiveIntegerParam(params, "timeoutMs"),
  };
}

export function createCanvasTool(options?: CanvasToolOptions): AnyAgentTool {
  return {
    ...canvasToolDefinition,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      const gatewayOpts = readGatewayCallOptions(params);
      const nodeQuery = readStringParam(params, "node", { trim: true });

      const invoke = async (command: string, invokeParams?: Record<string, unknown>) => {
        const nodeId = resolveCanvasNodeFromList(await listNodes(gatewayOpts), nodeQuery).nodeId;
        const timeoutMs =
          clampPositiveTimerTimeoutMs(
            gatewayOpts.timeoutMs ?? DEFAULT_CANVAS_NODE_INVOKE_TIMEOUT_MS,
          ) ?? DEFAULT_CANVAS_NODE_INVOKE_TIMEOUT_MS;
        // Preserve the node lookup budget while letting Gateway outlive node execution.
        const transportTimeoutMs =
          addTimerTimeoutGraceMs(timeoutMs, CANVAS_NODE_INVOKE_TRANSPORT_GRACE_MS) ?? timeoutMs;
        const result = await callGatewayTool(
          "node.invoke",
          { ...gatewayOpts, timeoutMs: transportTimeoutMs },
          {
            nodeId,
            command,
            params: invokeParams,
            timeoutMs,
            idempotencyKey: randomUUID(),
            ...(options?.agentSessionKey ? { sessionKey: options.agentSessionKey } : {}),
          },
        );
        return { node: nodeId, result };
      };

      switch (action) {
        case "present": {
          const placement = {
            x: readFiniteNumberParam(params, "x"),
            y: readFiniteNumberParam(params, "y"),
            width: readFiniteNumberParam(params, "width"),
            height: readFiniteNumberParam(params, "height"),
          };
          const invokeParams: Record<string, unknown> = {};
          const presentTarget =
            readStringParam(params, "target", { trim: true }) ??
            readStringParam(params, "url", { trim: true });
          if (presentTarget) {
            invokeParams.url = presentTarget;
          }
          if (Object.values(placement).some(Number.isFinite)) {
            invokeParams.placement = placement;
          }
          const { node } = await invoke(CANVAS_PRESENT_COMMAND, invokeParams);
          return jsonResult({ ok: true, node, ...(presentTarget ? { url: presentTarget } : {}) });
        }
        case "hide": {
          const { node } = await invoke("canvas.hide", undefined);
          return jsonResult({ ok: true, node });
        }
        case "navigate": {
          const url =
            readStringParam(params, "url", { trim: true }) ??
            readStringParam(params, "target", { required: true, trim: true, label: "url" });
          const { node } = await invoke("canvas.navigate", { url });
          return jsonResult({ ok: true, node, url });
        }
        default:
          throw new Error(`Unknown action: ${action}`);
      }
    },
  };
}
