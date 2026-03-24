import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginService,
  OpenClawPluginServiceContext,
} from "openclaw/plugin-sdk/jarvis";
import { JarvisMcpClient } from "./src/mcp-client.js";
import { checkPythonEnvironment, resolveJarvisPath } from "./src/python-check.js";
import { bridgeAllTools } from "./src/tool-bridge.js";

type JarvisPluginConfig = {
  pythonCommand?: string;
  jarvisPath?: string;
  startupTimeoutMs?: number;
};

function createJarvisService(
  api: OpenClawPluginApi,
  config: JarvisPluginConfig,
): OpenClawPluginService {
  let client: JarvisMcpClient | null = null;
  let lifecycleRevision = 0;

  return {
    id: "jarvis-mcp",
    async start(ctx: OpenClawPluginServiceContext): Promise<void> {
      lifecycleRevision += 1;
      const currentRevision = lifecycleRevision;

      // Fire-and-forget async setup so we don't block gateway startup.
      void (async () => {
        try {
          // 1. Check Python environment
          const pythonCmd = config.pythonCommand ?? "python3";
          const pyCheck = await checkPythonEnvironment({ pythonCommand: pythonCmd });
          if (!pyCheck.ok) {
            ctx.logger.warn(
              `[jarvis] Python not available: ${pyCheck.message}\n${pyCheck.setupInstructions}`,
            );
            return;
          }
          if (currentRevision !== lifecycleRevision) return;

          // 2. Resolve Jarvis path
          const jarvisPath = resolveJarvisPath(config.jarvisPath);
          if (!jarvisPath) {
            ctx.logger.warn(
              "[jarvis] Jarvis plugin not found. Install it via: pip install jarvis-methodology-agent",
            );
            return;
          }
          if (currentRevision !== lifecycleRevision) return;

          // 3. Start MCP server
          client = new JarvisMcpClient({
            pythonCommand: pyCheck.pythonCommand,
            jarvisPath,
            startupTimeoutMs: config.startupTimeoutMs,
            logger: ctx.logger,
          });

          const tools = await client.start();
          if (currentRevision !== lifecycleRevision) {
            client.stop();
            client = null;
            return;
          }

          ctx.logger.info(`[jarvis] MCP server started with ${tools.length} tools.`);

          // 4. Register all tools
          const bridgedTools = bridgeAllTools(tools, client, ctx.logger);
          for (const tool of bridgedTools) {
            // Cast parameters to satisfy AnyAgentTool's TSchema constraint at runtime;
            // MCP input schemas are structurally compatible JSON schemas.
            api.registerTool(tool as unknown as AnyAgentTool, { optional: true });
          }

          ctx.logger.info(`[jarvis] Registered ${bridgedTools.length} tools.`);
        } catch (err) {
          if (currentRevision !== lifecycleRevision) return;
          ctx.logger.warn(
            `[jarvis] Setup failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      })();
    },

    async stop(_ctx: OpenClawPluginServiceContext): Promise<void> {
      lifecycleRevision += 1;
      if (client) {
        client.stop();
        client = null;
      }
    },
  };
}

const jarvisPlugin = {
  id: "jarvis",
  name: "Jarvis",
  description:
    "Neuroscience-inspired persistent memory and cognitive profiling (MCP bridge to Python server).",
  kind: "memory" as const,
  configSchema: {
    safeParse(value: unknown) {
      if (value === undefined || value === null) {
        return { success: true as const, data: {} };
      }
      if (typeof value !== "object") {
        return {
          success: false as const,
          error: { issues: [{ path: [] as Array<string | number>, message: "Expected object" }] },
        };
      }
      return { success: true as const, data: value };
    },
    jsonSchema: {
      type: "object" as const,
      additionalProperties: false,
      properties: {
        pythonCommand: { type: "string" },
        jarvisPath: { type: "string" },
        startupTimeoutMs: { type: "number" },
      },
    },
  },

  register(api: OpenClawPluginApi) {
    const config = (api.pluginConfig ?? {}) as JarvisPluginConfig;
    api.registerService(createJarvisService(api, config));
  },
};

export default jarvisPlugin;
