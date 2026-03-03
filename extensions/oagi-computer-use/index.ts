import {
  DefaultAgent,
  ScreenshotMaker,
  DefaultActionHandler,
  AsyncAgentObserver,
} from "@oagi/oagi";
import type { Step } from "@oagi/oagi";
import { Type } from "@sinclair/typebox";
import type {
  OpenClawPluginApi,
  ProviderAuthContext,
  ProviderAuthResult,
} from "openclaw/plugin-sdk";

const OAGI_BASE_URL = "https://api.agiopen.org";

type OagiPluginConfig = {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  maxSteps?: number;
  temperature?: number;
  stepDelay?: number;
};

const plugin = {
  id: "oagi-computer-use",
  name: "OAGI Computer Use",
  description: "Computer-use agent powered by OAGI Lux model",

  register(api: OpenClawPluginApi) {
    const cfg = (api.pluginConfig ?? {}) as OagiPluginConfig;
    const log = api.logger;

    // Register provider for model discovery and API key auth
    api.registerProvider({
      id: "oagi",
      label: "OAGI (Lux)",
      aliases: ["lux"],
      envVars: ["OAGI_API_KEY"],
      models: {
        baseUrl: OAGI_BASE_URL,
        auth: "api-key",
        api: "openai-completions",
        models: [
          {
            id: "oagi/lux-actor-1",
            name: "Lux Actor 1",
            reasoning: false,
            input: ["text", "image"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128_000,
            maxTokens: 4096,
          },
          {
            id: "oagi/lux-thinker-1",
            name: "Lux Thinker 1",
            reasoning: true,
            input: ["text", "image"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128_000,
            maxTokens: 4096,
          },
        ],
      },
      auth: [
        {
          id: "api-key",
          label: "API Key",
          hint: "Enter your OAGI API key",
          kind: "api_key",
          async run(ctx: ProviderAuthContext): Promise<ProviderAuthResult> {
            const key = String(
              await ctx.prompter.text({ message: "Enter your OAGI API key:" }),
            ).trim();
            if (!key) {
              throw new Error("API key is required");
            }
            return {
              profiles: [
                {
                  profileId: "oagi:default",
                  credential: { type: "api_key", provider: "oagi", key },
                },
              ],
              configPatch: {
                models: {
                  providers: {
                    oagi: {
                      baseUrl: OAGI_BASE_URL,
                      auth: "api-key",
                      api: "openai-completions",
                      models: [
                        {
                          id: "oagi/lux-actor-1",
                          name: "Lux Actor 1",
                          reasoning: false,
                          input: ["text", "image"],
                          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                          contextWindow: 128_000,
                          maxTokens: 4096,
                        },
                        {
                          id: "oagi/lux-thinker-1",
                          name: "Lux Thinker 1",
                          reasoning: true,
                          input: ["text", "image"],
                          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                          contextWindow: 128_000,
                          maxTokens: 4096,
                        },
                      ],
                    },
                  },
                },
              },
              defaultModel: "oagi/lux-actor-1",
            };
          },
        },
      ],
    });

    // Register the computer-use tool
    api.registerTool(
      {
        name: "oagi_computer_use",
        label: "OAGI Computer Use",
        description:
          "Run short-horizon desktop UI actions with OAGI Lux (mouse/keyboard/screen). " +
          "Use this only for specific, deterministic targets that other OpenClaw tools cannot do " +
          "(for example: open a known page, click a known icon, set a named filter). " +
          "Avoid open-ended exploration or ambiguous goals. " +
          "For long workflows, decompose the objective into short, verifiable subtasks " +
          "and execute them step by step with separate calls. " +
          "If the task involves a web page or browser, use the browser tool to open the target URL in a new tab first, " +
          "then call this tool to interact with the page.",
        parameters: Type.Object({
          instruction: Type.String({
            description:
              "Specific UI task with concrete anchors (app/site, target text/icon/location, exact action, success condition).",
          }),
          model: Type.Optional(Type.String({ description: "Model ID (default: lux-actor-1)." })),
          maxSteps: Type.Optional(
            Type.Number({
              description:
                "Step budget for bounded runs; keep low for focused tasks (default: 20).",
            }),
          ),
        }),
        async execute(_toolCallId, params) {
          // TODO: resolve API key from stored auth profiles (needs plugin API support)
          const apiKey = cfg.apiKey || process.env.OAGI_API_KEY;
          if (!apiKey) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: "Error: OAGI API key not configured. Set OAGI_API_KEY or configure the plugin apiKey.",
                },
              ],
              details: { success: false, error: "missing_api_key" },
            };
          }

          const baseUrl = cfg.baseUrl || OAGI_BASE_URL;
          const model = params.model || cfg.model || "lux-actor-1";
          const maxSteps = params.maxSteps || cfg.maxSteps || 20;
          const temperature = cfg.temperature ?? 0.5;
          const stepDelay = cfg.stepDelay ?? 1.0;

          // Custom observer that logs in real-time and collects results
          const stepSummaries: string[] = [];
          let lastScreenshot: ArrayBuffer | undefined;
          const actionTypes: string[] = [];

          const observer = new AsyncAgentObserver();
          const originalOnEvent = observer.onEvent.bind(observer);
          observer.onEvent = async (event) => {
            await originalOnEvent(event);
            if (event.type === "step") {
              const step = (event as { step: Step }).step;
              const stepNum = (event as { step_num: number }).step_num;
              lastScreenshot = (event as { image: ArrayBuffer }).image;
              const actions = step.actions.map((a) => `${a.type}(${a.argument})`).join(", ");
              const summary = `Step ${stepNum}: ${step.reason || "(no reasoning)"}\n  Actions: ${actions || "none"}`;
              stepSummaries.push(summary);
              log.info(
                `[oagi] Step ${stepNum}: ${step.reason || "(no reasoning)"} | Actions: ${actions || "none"}`,
              );
            } else if (event.type === "action") {
              const actions = (event as { actions: { type: string }[] }).actions;
              for (const a of actions) {
                actionTypes.push(a.type);
              }
            }
          };

          const agent = new DefaultAgent(
            apiKey,
            baseUrl,
            model,
            maxSteps,
            temperature,
            observer,
            stepDelay,
          );
          const imageProvider = new ScreenshotMaker();
          const actionHandler = new DefaultActionHandler();

          log.info(
            `[oagi] Starting task: ${params.instruction} (model=${model}, maxSteps=${maxSteps})`,
          );
          let success: boolean;
          try {
            success = await agent.execute(params.instruction, actionHandler, imageProvider);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            log.warn(`[oagi] Task failed with error: ${message}`);
            const isNativeDep = /robotjs|sharp/.test(message);
            const hint = isNativeDep
              ? "\n\nThis tool requires native desktop-automation libraries (robotjs, sharp) " +
                "that must be compiled for your platform.\n" +
                "- macOS/Linux workspace: run `pnpm install` from the repo root (the postinstall script builds them automatically).\n" +
                "- Plugin install (`openclaw plugins install`): native build scripts are skipped for security. " +
                "Run `npx node-gyp rebuild` manually inside the robotjs package directory."
              : "";
            return {
              content: [{ type: "text" as const, text: `Error: ${message}${hint}` }],
              details: {
                success: false,
                error: isNativeDep ? "native_deps_missing" : "execution_error",
              },
            };
          }
          log.info(
            `[oagi] Task ${success ? "completed" : "did not complete"} after ${stepSummaries.length} steps`,
          );

          type ContentBlock =
            | { type: "text"; text: string }
            | { type: "image"; data: string; mimeType: string };
          const content: ContentBlock[] = [
            {
              type: "text" as const,
              text: [
                success
                  ? "Task completed successfully."
                  : "Task did not complete within the maximum number of steps.",
                "",
                ...stepSummaries,
              ].join("\n"),
            },
          ];

          // Include final screenshot so the host LLM can verify the result
          if (lastScreenshot) {
            content.push({
              type: "image" as const,
              data: Buffer.from(lastScreenshot).toString("base64"),
              mimeType: "image/jpeg",
            });
          }

          return {
            content,
            details: { success, totalSteps: stepSummaries.length, actionTypes },
          };
        },
      },
      { name: "oagi_computer_use" },
    );
  },
};

export default plugin;
