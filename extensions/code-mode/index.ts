import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { buildCodeModeContext } from "./src/api-generator.js";
import { executeSandboxCode } from "./src/sandbox.js";
import type { AgentFilter, CodeModePluginConfig } from "./src/types.js";

/** Check whether the plugin should be active for a given agent ID. */
function isAgentEnabled(filter: AgentFilter | undefined, agentId: string | undefined): boolean {
  if (!filter) return true;
  if (filter.include) return agentId != null && filter.include.includes(agentId);
  if (filter.exclude) return agentId == null || !filter.exclude.includes(agentId);
  return true;
}

const DEFAULT_TIMEOUT_MS = 30_000;

const codeModePlugin = {
  id: "code-mode",
  name: "Code Mode",
  description:
    "Collapses tools into a single execute_code tool with TypeScript API bindings for multi-step orchestration.",
  configSchema: emptyPluginConfigSchema(),

  register(api: OpenClawPluginApi) {
    const pluginCfg = (api.pluginConfig ?? {}) as CodeModePluginConfig;
    const allowNetwork = pluginCfg.allowNetwork === true;
    const agentFilter = pluginCfg.agents;
    const timeoutMs =
      typeof pluginCfg.timeoutMs === "number" && pluginCfg.timeoutMs > 0
        ? pluginCfg.timeoutMs
        : DEFAULT_TIMEOUT_MS;

    // Inject code-mode API documentation into the system prompt so
    // the LLM knows what methods the execute_code sandbox offers.
    api.on("before_prompt_build", (_event, ctx) => {
      if (!isAgentEnabled(agentFilter, ctx.agentId)) return;
      const context = buildCodeModeContext({ allowNetwork });
      return { prependContext: context };
    });

    api.registerTool(
      (ctx) => {
        const workspaceDir = ctx.workspaceDir ?? process.cwd();
        // Return null to skip tool registration for excluded agents
        if (!isAgentEnabled(agentFilter, ctx.agentId)) return null;

        // Build method list dynamically — hide `fetch` when network is disabled
        const availableMethods = ["readFile", "writeFile", "listFiles", "exec"];
        if (allowNetwork) {
          availableMethods.push("fetch");
        }
        availableMethods.push("log");

        const methodListStr = availableMethods.join(", ");

        const descriptionParts = [
          "Execute JavaScript code in a sandboxed environment.",
          `The code has access to a global \`api\` object with methods: ${methodListStr}.`,
          "Use this to perform multi-step operations in a single tool call instead of calling tools one at a time.",
          "The code runs in an async context; the last expression value is returned as the result.",
          "Use `api.log()` for intermediate output.",
          // Not a security sandbox — vm provides scope constraints, not OS-level isolation.
        ];

        return {
          name: "execute_code",
          label: "Execute Code",
          description: descriptionParts.join(" "),
          parameters: Type.Object({
            code: Type.String({
              description: `JavaScript code to execute. Has access to a global \`api\` object with ${methodListStr} methods. The code runs inside an async function so \`await\` works at the top level.`,
            }),
          }),
          async execute(_toolCallId: string, params: Record<string, unknown>) {
            const code = typeof params.code === "string" ? params.code.trim() : "";
            if (!code) {
              throw new Error("code parameter is required");
            }

            const result = await executeSandboxCode(code, {
              workspaceDir,
              timeoutMs,
              allowNetwork,
            });

            const outputParts: string[] = [];

            if (result.logs.length > 0) {
              outputParts.push("--- Logs ---");
              outputParts.push(result.logs.join("\n"));
            }

            if (result.success) {
              outputParts.push("--- Result ---");
              if (result.result !== undefined) {
                outputParts.push(
                  typeof result.result === "string"
                    ? result.result
                    : JSON.stringify(result.result, null, 2),
                );
              } else {
                outputParts.push("(no return value)");
              }
            } else {
              outputParts.push("--- Error ---");
              outputParts.push(result.error ?? "Unknown error");
            }

            const text = outputParts.join("\n");

            if (!result.success) {
              return {
                content: [{ type: "text", text }],
                details: { success: false, error: result.error, logs: result.logs },
              };
            }

            return {
              content: [{ type: "text", text }],
              details: { success: true, result: result.result, logs: result.logs },
            };
          },
        };
      },
      { names: ["execute_code"] },
    );
  },
};

export default codeModePlugin;
