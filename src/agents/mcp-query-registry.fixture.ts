/**
 * Fake MCP server fixture for the query-registry workflow.
 *
 * The server exposes four canonical tools:
 *   - demo_context
 *   - demo_queries_list
 *   - demo_query_describe
 *   - demo_query_execute
 *
 * It intentionally enforces a policy in fixture code: a query id must be
 * described before it can be executed. This lets tests verify that agents
 * (or any caller) do not skip the describe step and invent parameters.
 */
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const SDK_SERVER_MCP_PATH = require.resolve("@modelcontextprotocol/sdk/server/mcp.js");
const SDK_SERVER_STDIO_PATH = require.resolve("@modelcontextprotocol/sdk/server/stdio.js");
const ZOD_PATH = require.resolve("zod");

export const QUERY_REGISTRY_SERVER_NAME = "queryRegistry" as const;

export const QUERY_REGISTRY_TOOLS = {
  CONTEXT: "demo_context",
  QUERIES_LIST: "demo_queries_list",
  QUERY_DESCRIBE: "demo_query_describe",
  QUERY_EXECUTE: "demo_query_execute",
} as const;

export const QUERY_REGISTRY_QUERIES = {
  AUD004: { required: ["filial", "data"] },
  CAD005: { required: ["termo"] },
} as const;

export type QueryRegistryQueryId = keyof typeof QUERY_REGISTRY_QUERIES;

export async function writeQueryRegistryMcpServer(
  filePath: string,
  params: { logPath?: string } = {},
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    filePath,
    `#!/usr/bin/env node
import { McpServer } from ${JSON.stringify(SDK_SERVER_MCP_PATH)};
import { StdioServerTransport } from ${JSON.stringify(SDK_SERVER_STDIO_PATH)};
import { z } from ${JSON.stringify(ZOD_PATH)};

const logPath = ${JSON.stringify(params.logPath ?? "")};

async function log(line) {
  if (!logPath) return;
  await import("node:fs/promises")
    .then((fs) => fs.appendFile(logPath, line + "\\n", "utf8"))
    .catch(() => {});
}

// Track which query ids have been described. The fixture enforces
// describe-before-execute so tests can prove callers do not bypass discovery.
const describedQueries = new Set();

const server = new McpServer({ name: "query-registry-demo", version: "1.0.0" });

server.tool(
  "demo_context",
  "Returns compact domain context for the query registry.",
  {},
  async () => {
    await log("call demo_context");
    return {
      content: [{
        type: "text",
        text: "Domain: finance demo. Fiscal branches: filial A, filial B.",
      }],
    };
  },
);

server.tool(
  "demo_queries_list",
  "Returns a compact list of available read-only queries.",
  {},
  async () => {
    await log("call demo_queries_list");
    // Compact list: only ids and required param names. Full schemas are fetched
    // via demo_query_describe so the LLM prompt does not get flooded with a
    // large catalog.
    return {
      content: [{
        type: "text",
        text: JSON.stringify([
          { queryId: "AUD004", required: ["filial", "data"] },
          { queryId: "CAD005", required: ["termo"] },
        ]),
      }],
    };
  },
);

server.tool(
  "demo_query_describe",
  "Returns the full parameter schema for a single query id.",
  { queryId: z.string().min(1) },
  async ({ queryId }) => {
    await log("call demo_query_describe " + queryId);
    const schemas = {
      AUD004: {
        type: "object",
        properties: {
          filial: { type: "string" },
          data: { type: "string" },
        },
        required: ["filial", "data"],
      },
      CAD005: {
        type: "object",
        properties: {
          termo: { type: "string" },
        },
        required: ["termo"],
      },
    };
    const schema = schemas[queryId];
    if (!schema) {
      return {
        content: [{ type: "text", text: "Unknown query id: " + queryId }],
        isError: true,
      };
    }
    describedQueries.add(queryId);
    return {
      content: [{ type: "text", text: JSON.stringify(schema) }],
    };
  },
);

server.tool(
  "demo_query_execute",
  "Executes a described query with the provided parameters.",
  {
    queryId: z.string().min(1),
    params: z.object({}).passthrough(),
  },
  async ({ queryId, params }) => {
    await log("call demo_query_execute " + queryId);
    // Enforce the registry contract: execute only after describe. This catches
    // callers that guess query shapes or skip the describe step.
    if (!describedQueries.has(queryId)) {
      return {
        content: [{
          type: "text",
          text: "Query " + queryId + " must be described before execute.",
        }],
        isError: true,
      };
    }
    if (queryId === "AUD004") {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            result: "AUD004 snapshot",
            filial: params.filial,
            data: params.data,
          }),
        }],
      };
    }
    if (queryId === "CAD005") {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            result: "CAD005 snapshot",
            termo: params.termo,
          }),
        }],
      };
    }
    return {
      content: [{ type: "text", text: "Unknown query id: " + queryId }],
      isError: true,
    };
  },
);

await server.connect(new StdioServerTransport());
`,
    { encoding: "utf-8", mode: 0o755 },
  );
}
