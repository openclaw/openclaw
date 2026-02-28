/**
 * BusinessClaw (BCL) - Autonomous AI Business Agent Extension
 *
 * OpenClaw Extension for 24/7 autonomous business operations
 */

import { Type } from "@sinclair/typebox";
import type { AnyAgentTool, OpenClawPluginApi } from "../../src/plugins/types.js";
import { Database } from "./src/db/database.js";
import { BCL_CORE_VALUES } from "./src/types/index.js";

let db: Database | null = null;

const BCLToolSchema = Type.Object({
  agent: Type.Union([
    Type.Literal("research"),
    Type.Literal("competitor"),
    Type.Literal("builder"),
    Type.Literal("security"),
    Type.Literal("marketer"),
    Type.Literal("finance"),
  ]),
  action: Type.String(),
  params: Type.Optional(Type.Object({})),
});

type BCLToolParams = {
  agent: "research" | "competitor" | "builder" | "security" | "marketer" | "finance";
  action: string;
  params?: Record<string, unknown>;
};

function jsonResult(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

async function executeBCLTool(
  _toolCallId: string,
  params: BCLToolParams,
  _signal?: AbortSignal,
  _onUpdate?: unknown,
) {
  if (!db) {
    return jsonResult({ success: false, error: "BCL not initialized" });
  }
  return jsonResult({
    success: true,
    message: `Would execute ${params.agent} with action ${params.action}`,
  });
}

/**
 * Main extension registration function
 */
export default function register(api: OpenClawPluginApi) {
  api.logger.info("BusinessClaw (BCL) extension initializing...");

  try {
    db = new Database();
    db.initialize();
    api.logger.info("BCL Database initialized");
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    api.logger.error("Failed to initialize BCL database: " + errMsg);
    return;
  }

  api.registerCommand({
    name: "bcl:status",
    description: "Get BCL system status",
    handler: async () => {
      const health = db?.getHealthStatus();
      return {
        text: `BCL System Status:\n- Database: ${health?.database ? "OK" : "FAIL"}\n- Last Check: ${health?.last_check?.toISOString() || "N/A"}`,
      };
    },
  });

  api.registerCommand({
    name: "bcl:start",
    description: "Start BCL master loop",
    handler: async () => {
      return { text: "BCL Master Loop started (orchestrator removed)" };
    },
  });

  api.registerCommand({
    name: "bcl:stop",
    description: "Stop BCL master loop",
    handler: async () => {
      return { text: "BCL Master Loop stopped" };
    },
  });

  api.registerCommand({
    name: "bcl:agents",
    description: "List all BCL agents and their status",
    handler: async () => {
      const health = db?.getHealthStatus();
      let output = "BCL Agents Status:\n";
      if (health?.agents) {
        for (const [agent, status] of Object.entries(
          health.agents as Record<string, { status: string; error_count: number }>,
        )) {
          output += `- ${agent}: ${status.status} (errors: ${status.error_count})\n`;
        }
      }
      return { text: output };
    },
  });

  api.registerTool({
    name: "bcl_execute",
    label: "BCL Execute",
    description: "Execute a BCL agent task",
    parameters: BCLToolSchema,
    execute: executeBCLTool,
  } as AnyAgentTool);

  api.logger.info("BusinessClaw (BCL) extension ready");
}

export { BCL_CORE_VALUES };
