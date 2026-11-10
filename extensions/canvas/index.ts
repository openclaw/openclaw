import { randomUUID } from "node:crypto";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { definePluginEntry, type AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { canvasConfigSchema, isCanvasHostEnabled } from "./src/config.js";
import { CANVAS_PRESENT_COMMAND, isEligibleCanvasNode } from "./src/node-eligibility.js";
import { canvasToolDefinition } from "./src/tool-schema.js";

const DEFAULT_CANVAS_NODE_INVOKE_TIMEOUT_MS = 30_000;
const CANVAS_NODE_COMMANDS = ["canvas.present", "canvas.hide", "canvas.navigate"];

function createLazyCanvasTool(agentSessionKey?: string): AnyAgentTool {
  const loadTool = createLazyRuntimeModule(() =>
    import("./src/tool.js").then(({ createCanvasTool }) => createCanvasTool({ agentSessionKey })),
  );
  return {
    ...canvasToolDefinition,
    execute: async (...args: Parameters<AnyAgentTool["execute"]>) =>
      await (await loadTool()).execute(...args),
  };
}

export default definePluginEntry({
  id: "canvas",
  name: "Canvas",
  description: "Presents hosted widget documents on paired macOS panels.",
  configSchema: canvasConfigSchema,
  register(api) {
    if (isCanvasHostEnabled(api.config)) {
      const nodesRuntime = api.runtime.nodes;
      type CanvasRuntimeNode = Awaited<ReturnType<typeof nodesRuntime.list>>["nodes"][number];
      async function selectCanvasNode(): Promise<CanvasRuntimeNode | null> {
        const { selectDefaultNodeFromList } =
          await import("openclaw/plugin-sdk/agent-harness-runtime");
        const { nodes } = await nodesRuntime.list({ connected: true });
        return selectDefaultNodeFromList(nodes.filter(isEligibleCanvasNode), {
          capability: "canvas",
          fallback: "first",
          preferLocalMac: true,
        });
      }

      api.registerWidgetPresenter({
        target: "node_panel",
        description: "Show on a connected device panel",
        async availability() {
          try {
            const node = await selectCanvasNode();
            return node
              ? { ok: true, value: { available: true } }
              : {
                  ok: false,
                  error: {
                    code: "no_eligible_node",
                    message: "No connected canvas-capable device is available.",
                  },
                };
          } catch (error) {
            return {
              ok: false,
              error: { code: "node_error", message: formatErrorMessage(error) },
            };
          }
        },
        async present({ document, context }) {
          if (!document.hostedUrl) {
            return {
              ok: false,
              error: {
                code: "node_error",
                message: "The widget document is not hosted for device presentation.",
              },
            };
          }
          let node: CanvasRuntimeNode | null;
          try {
            node = await selectCanvasNode();
          } catch (error) {
            return {
              ok: false,
              error: { code: "node_error", message: formatErrorMessage(error) },
            };
          }
          if (!node) {
            return {
              ok: false,
              error: {
                code: "no_eligible_node",
                message: "No connected canvas-capable device is available.",
              },
            };
          }
          try {
            await nodesRuntime.invoke({
              nodeId: node.nodeId,
              command: CANVAS_PRESENT_COMMAND,
              params: { url: document.hostedUrl },
              timeoutMs: DEFAULT_CANVAS_NODE_INVOKE_TIMEOUT_MS,
              idempotencyKey: randomUUID(),
              ...(context.sessionKey ? { sessionKey: context.sessionKey } : {}),
            });
            return {
              ok: true,
              value: {
                kind: "node",
                nodeId: node.nodeId,
                ...(node.displayName ? { nodeName: node.displayName } : {}),
              },
            };
          } catch (error) {
            return {
              ok: false,
              error: {
                code: "node_error",
                message: formatErrorMessage(error),
                nodeId: node.nodeId,
              },
            };
          }
        },
      });
    }
    api.registerNodeInvokePolicy({
      commands: CANVAS_NODE_COMMANDS,
      defaultPlatforms: ["macos"],
      handle: async (ctx) => await ctx.invokeNode(),
    });
    api.registerTool((ctx) => createLazyCanvasTool(ctx.sessionKey));
    api.registerNodeCliFeature(
      async ({ program }) => {
        const { registerNodesCanvasCommands } = await import("./src/cli.js");
        registerNodesCanvasCommands(program);
      },
      {
        descriptors: [
          {
            name: "canvas",
            description: "Present widget documents on a paired macOS panel",
            hasSubcommands: true,
          },
        ],
      },
    );
  },
});
