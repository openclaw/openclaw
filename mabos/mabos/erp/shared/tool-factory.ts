import type { PgClient } from "../db/postgres.js";
import type { TypeDBClient } from "../db/typedb.js";

export interface ErpAction<TParams = Record<string, unknown>, TResult = unknown> {
  name: string;
  description: string;
  params: Record<string, { type: string; description: string; required?: boolean }>;
  handler: (params: TParams, ctx: ErpToolContext) => Promise<TResult>;
}

export interface ErpToolContext {
  agentId: string;
  agentDir: string;
  pg: PgClient;
  typedb: TypeDBClient;
  syncEngine: { syncErpToBdi: (params: Record<string, unknown>) => Promise<void> } | null;
  logger: { info: (msg: string) => void; warn: (msg: string) => void };
}

export interface ErpDomainDef {
  domain: string;
  description: string;
  actions: ErpAction[];
}

export interface ErpToolInput {
  action: string;
  params?: Record<string, unknown>;
}

export interface ErpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (input: ErpToolInput, ctx: ErpToolContext) => Promise<unknown>;
}

export function createErpDomainTool(def: ErpDomainDef): ErpTool {
  const actionNames = def.actions.map((a) => a.name);

  return {
    name: `erp_${def.domain}`,
    description: `${def.description}\n\nAvailable actions: ${actionNames.join(", ")}`,
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description: `The action to perform. One of: ${actionNames.join(", ")}`,
        },
        params: {
          type: "object",
          description: "Action-specific parameters",
        },
      },
      required: ["action"],
    },
    execute: async (input: ErpToolInput, ctx: ErpToolContext) => {
      const actionDef = def.actions.find((a) => a.name === input.action);
      if (!actionDef) {
        return { error: `Unknown action: ${input.action}. Available: ${actionNames.join(", ")}` };
      }
      return actionDef.handler(input.params ?? {}, ctx);
    },
  };
}
