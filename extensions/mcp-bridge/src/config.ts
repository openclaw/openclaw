import { z } from "zod";
import type { McpBridgeConfig } from "./types.js";

const StdioServerSchema = z.object({
  name: z.string().min(1),
  type: z.literal("stdio"),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
});

const HttpServerSchema = z.object({
  name: z.string().min(1),
  type: z.literal("http"),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
});

const SseServerSchema = z.object({
  name: z.string().min(1),
  type: z.literal("sse"),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
});

const ServerSchema = z.discriminatedUnion("type", [
  StdioServerSchema,
  HttpServerSchema,
  SseServerSchema,
]);

const McpBridgeConfigSchema = z.object({
  servers: z.array(ServerSchema).min(1),
});

export function parseConfig(raw: unknown): McpBridgeConfig {
  return McpBridgeConfigSchema.parse(raw) as McpBridgeConfig;
}

export const configSchema = {
  safeParse(value: unknown) {
    const result = McpBridgeConfigSchema.safeParse(value);
    if (result.success) {
      return { success: true, data: result.data };
    }
    return {
      success: false,
      error: {
        issues: result.error.issues.map((i) => ({
          path: i.path.map(String),
          message: i.message,
        })),
      },
    };
  },
  jsonSchema: {
    type: "object",
    properties: {
      servers: {
        type: "array",
        description: "MCP servers to bridge",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "Prefix for tool names (e.g. lark_project)" },
            type: { type: "string", enum: ["stdio", "sse", "http"], description: "Transport type" },
            url: { type: "string", description: "Server URL (for http/sse)" },
            command: { type: "string", description: "Command to run (for stdio)" },
            args: {
              type: "array",
              items: { type: "string" },
              description: "Command args (for stdio)",
            },
            headers: { type: "object", description: "HTTP headers (for http/sse)" },
          },
          required: ["name", "type"],
        },
      },
    },
    required: ["servers"],
  },
};
