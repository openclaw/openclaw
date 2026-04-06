import { definePluginEntry, type OpenClawPluginApi } from "./runtime-api.js";
import {
  openstreamPluginConfigSchema,
  resolveOpenStreamPluginConfig,
} from "./src/config.js";
import {
  buildOpenStreamDoctorReport,
  buildSuggestedPluginConfig,
  buildSuggestedRuntimeConfig,
  formatDoctorReport,
} from "./src/doctor.js";
import { OPENSTREAM_AGENT_GUIDANCE } from "./src/guidance.js";
import { buildModelHint } from "./src/heuristics.js";

type DoctorAction = "doctor" | "sample_config" | "model_hint";

function renderJson(payload: unknown): string {
  return JSON.stringify(payload, null, 2);
}

function formatHelp(): string {
  return [
    "OpenStream commands:",
    "",
    "/openstream doctor [model]",
    "/openstream model <modelId>",
    "/openstream sample-config",
    "/openstream help",
    "",
    "Use this plugin when you want Ollama-focused diagnostics, heuristic recommendations, or plugin/core bridge setup guidance.",
  ].join("\n");
}

function parseCommandArgs(rawArgs: string | undefined): { action: DoctorAction | "help"; rest: string } {
  const args = (rawArgs ?? "").trim();
  if (!args) {
    return { action: "doctor", rest: "" };
  }
  const [first, ...rest] = args.split(/\s+/);
  const action = first.toLowerCase();
  if (action === "doctor" || action === "sample-config") {
    return {
      action: action === "sample-config" ? "sample_config" : "doctor",
      rest: rest.join(" ").trim(),
    };
  }
  if (action === "model" || action === "hint" || action === "heuristics") {
    return { action: "model_hint", rest: rest.join(" ").trim() };
  }
  if (action === "help" || action === "status") {
    return { action: action === "status" ? "doctor" : "help", rest: rest.join(" ").trim() };
  }
  return { action: "doctor", rest: args };
}

function makeToolResponse(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: renderJson(payload) }],
    details: payload,
  };
}

function resolveHostConfig(api: OpenClawPluginApi) {
  return api.runtime.config.loadConfig();
}

export default definePluginEntry({
  id: "openstream",
  name: "OpenStream",
  description:
    "Ollama companion plugin with diagnostics, prompt guidance, and heuristic recommendations.",
  configSchema: openstreamPluginConfigSchema,
  register(api: OpenClawPluginApi) {
    const pluginConfig = resolveOpenStreamPluginConfig(api.pluginConfig);

    api.registerCommand({
      name: "openstream",
      description: "Inspect OpenStream plugin state and generate Ollama-oriented setup guidance.",
      acceptsArgs: true,
      handler: async (ctx) => {
        const parsed = parseCommandArgs(ctx.args);
        const hostConfig = ctx.config ?? resolveHostConfig(api);
        if (parsed.action === "help") {
          return { text: formatHelp() };
        }
        if (parsed.action === "sample_config") {
          return {
            text:
              "Plugin config:\n```json\n" +
              `${renderJson(buildSuggestedPluginConfig(pluginConfig))}\n` +
              "```\n\nRuntime bridge config:\n```json\n" +
              `${renderJson(buildSuggestedRuntimeConfig(pluginConfig))}\n` +
              "```",
          };
        }
        if (parsed.action === "model_hint") {
          if (!parsed.rest) {
            return { text: "Usage: /openstream model <modelId>" };
          }
          return {
            text: `\`\`\`json\n${renderJson(buildModelHint(parsed.rest, pluginConfig))}\n\`\`\``,
          };
        }
        const report = buildOpenStreamDoctorReport({
          hostConfig,
          pluginConfig,
          ...(parsed.rest ? { targetModelId: parsed.rest } : {}),
        });
        return { text: formatDoctorReport(report) };
      },
    });

    api.registerCli(
      ({ program }) => {
        const cmd = program.command("openstream").description("OpenStream plugin diagnostics");
        cmd
          .command("doctor")
          .argument("[model]", "Optional model id to evaluate")
          .action((model?: string) => {
            const report = buildOpenStreamDoctorReport({
              hostConfig: resolveHostConfig(api),
              pluginConfig,
              ...(model ? { targetModelId: model } : {}),
            });
            console.log(formatDoctorReport(report));
          });
        cmd
          .command("model")
          .argument("<model>", "Model id to evaluate")
          .action((model: string) => {
            console.log(renderJson(buildModelHint(model, pluginConfig)));
          });
        cmd.command("sample-config").action(() => {
          console.log(renderJson(buildSuggestedPluginConfig(pluginConfig)));
          console.log("");
          console.log(renderJson(buildSuggestedRuntimeConfig(pluginConfig)));
        });
      },
      { commands: ["openstream"] },
    );

    api.registerTool({
      name: "openstream_doctor",
      label: "OpenStream Doctor",
      description:
        "Inspect Ollama/OpenStream setup, generate plugin or runtime-bridge config, and explain model heuristics.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          action: {
            type: "string",
            enum: ["doctor", "sample_config", "model_hint"],
          },
          model: {
            type: "string",
            description: "Optional model id for targeted heuristics.",
          },
        },
      },
      async execute(_toolCallId, params) {
        const action =
          params &&
          typeof params === "object" &&
          typeof (params as Record<string, unknown>).action === "string"
            ? ((params as Record<string, unknown>).action as DoctorAction)
            : "doctor";
        const model =
          params &&
          typeof params === "object" &&
          typeof (params as Record<string, unknown>).model === "string"
            ? ((params as Record<string, unknown>).model as string)
            : undefined;

        if (action === "sample_config") {
          return makeToolResponse({
            pluginConfig: buildSuggestedPluginConfig(pluginConfig),
            runtimeBridgeConfig: buildSuggestedRuntimeConfig(pluginConfig),
          });
        }
        if (action === "model_hint") {
          if (!model) {
            throw new Error("model is required when action=model_hint");
          }
          return makeToolResponse(buildModelHint(model, pluginConfig));
        }
        return makeToolResponse(
          buildOpenStreamDoctorReport({
            hostConfig: resolveHostConfig(api),
            pluginConfig,
            ...(model ? { targetModelId: model } : {}),
          }),
        );
      },
    });

    if (pluginConfig.promptGuidance) {
      api.on("before_prompt_build", async () => ({
        prependSystemContext: OPENSTREAM_AGENT_GUIDANCE,
      }));
    }
  },
});
