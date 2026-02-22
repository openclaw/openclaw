import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk";
import { registerDoclingCli } from "./src/cli.js";
import { createDoclingTools } from "./src/tools.js";

const plugin = {
  id: "docling-rag",
  name: "Docling RAG",
  description: "Document processing and RAG via Docling. Ingest PDFs, Word, Excel; search and answer from your documents.",
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      enabled: { type: "boolean" },
      doclingPath: { type: "string" },
      dbPath: { type: "string" },
      embedding: {
        type: "object",
        properties: {
          provider: { type: "string", enum: ["openai"] },
          model: { type: "string" },
          apiKey: { type: "string" },
        },
      },
      chunkSize: { type: "number" },
      chunkOverlap: { type: "number" },
    },
  },

  register(api: OpenClawPluginApi) {
    const tools = createDoclingTools(api);
    for (const tool of tools) {
      api.registerTool(tool as unknown as AnyAgentTool, { optional: true });
    }

    api.registerCli(
      (ctx) => {
        registerDoclingCli(ctx.program, {
          resolvePath: api.resolvePath,
          pluginConfig: api.pluginConfig,
        });
      },
      { commands: ["docling"] },
    );
  },
};

export default plugin;
