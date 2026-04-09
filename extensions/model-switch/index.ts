import { Type } from "@sinclair/typebox";
import type { Static } from "@sinclair/typebox";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { resolveConfig } from "./src/config.js";
import { executeSwitch, recoverFromMarker } from "./src/executor.js";
import type { SwitchState } from "./src/executor.js";
import { detectActiveModel } from "./src/health.js";

/**
 * ## model-switch — Seamless Local LLM Model Switching
 *
 * Enables agents to switch between local inference backends (e.g., Gemma 4, Qwen 3.5,
 * Nemotron-3) on single-GPU workstations without losing session context. Uses the
 * `enqueueFollowupTurn()` API to resume work on the new model after the switch completes.
 *
 * ## Security Considerations
 *
 * - **No command injection:** Start/stop commands come from operator-defined plugin config,
 *   never from agent input. The agent provides only a model ID, resolved to a config-defined
 *   command. No shell interpolation of agent-provided strings.
 *
 * - **Mutual exclusion:** A switch lock prevents concurrent switches. The `switching` flag
 *   gates all inference requests during the switch window.
 *
 * - **Session key isolation:** The session key is read from the framework-provided tool
 *   context (`ctx.sessionKey`), never from agent parameters, preventing session hijacking.
 *
 * - **Opt-in only:** Disabled by default. Operators must configure the model registry.
 */

const modelSwitchParameters = Type.Object({
  target: Type.String({
    description:
      "Model ID to switch to (from the model registry). Call model_info with action 'list' to see available models.",
  }),
  reason: Type.Optional(
    Type.String({
      description: "Why the switch is needed (logged and included in the followup prompt).",
    }),
  ),
  continuationPrompt: Type.Optional(
    Type.String({
      description:
        "What the new model should do after the switch. Include the current task, progress, and context. This is the primary context bridge — make it self-contained.",
    }),
  ),
});

type ModelSwitchParams = Static<typeof modelSwitchParameters>;

const modelInfoParameters = Type.Object({
  action: Type.Union([Type.Literal("status"), Type.Literal("list"), Type.Literal("capabilities")], {
    description:
      "'status' = current model, 'list' = all models, 'capabilities' = detail for one model.",
  }),
  model: Type.Optional(
    Type.String({ description: "Model ID for 'capabilities' action. Defaults to active model." }),
  ),
});

type ModelInfoParams = Static<typeof modelInfoParameters>;

export default definePluginEntry({
  id: "model-switch",
  name: "Model Switch",
  description: "Seamless local LLM model switching with session continuation.",
  register(api) {
    const config = resolveConfig(api.pluginConfig);
    const followupRuntime = (api.runtime as Record<string, unknown>).followup as
      | {
          enqueueFollowupTurn: (p: {
            sessionKey: string;
            prompt: string;
            source: string;
          }) => Promise<boolean>;
        }
      | undefined;
    const stateDir = api.runtime.state.resolveStateDir();

    if (!followupRuntime) {
      api.logger.warn(
        "[model-switch] runtime.followup not available (requires enqueueFollowupTurn API). " +
          "Model switching will work but session continuation after switch is disabled.",
      );
    }

    // Shared mutable state between tool, hook, and service
    const state: SwitchState = {
      switching: false,
      activeModelId: null,
      switchPromise: null,
    };

    // Promise resolution for the gate hook
    let resolveSwitchPromise: (() => void) | null = null;

    const deps = {
      config,
      stateDir,
      logger: api.logger,
      enqueueFollowupTurn: followupRuntime
        ? followupRuntime.enqueueFollowupTurn.bind(followupRuntime)
        : async () => {
            api.logger.warn(
              "[model-switch] enqueueFollowupTurn not available. Session continuation skipped.",
            );
            return false;
          },
      onSwitchComplete: () => {
        if (resolveSwitchPromise) {
          resolveSwitchPromise();
          resolveSwitchPromise = null;
        }
      },
    };

    // --- Tool: model_switch ---
    api.registerTool((ctx) => ({
      name: "model_switch",
      label: "Model Switch",
      description:
        "Switch the active inference model. The current model will be stopped, the target model started, and work will resume automatically on the new model. Include a detailed continuationPrompt describing the current task and progress.",
      parameters: modelSwitchParameters,
      async execute(_toolCallId, params) {
        const parsed = params as ModelSwitchParams;
        const sessionKey = ctx.sessionKey;

        if (!sessionKey) {
          return textResult(
            "ERROR: No session key available. Cannot switch models outside a session.",
          );
        }

        if (!(parsed.target in config.models)) {
          const available = Object.keys(config.models).join(", ");
          return textResult(`ERROR: Unknown model "${parsed.target}". Available: ${available}`);
        }

        if (parsed.target === state.activeModelId) {
          return textResult(`Already running on ${parsed.target}. No switch needed.`);
        }

        if (state.switching) {
          return textResult(
            "ERROR: A model switch is already in progress. Wait for it to complete.",
          );
        }

        // Set gate: all incoming requests will be held
        state.switching = true;
        state.switchPromise = new Promise<boolean>((resolve) => {
          resolveSwitchPromise = () => resolve(true);
        });

        const prompt = parsed.continuationPrompt ?? "Continue with any remaining work.";

        // Schedule the switch asynchronously (runs after this tool call returns)
        setTimeout(() => {
          void executeSwitch(
            {
              sessionKey,
              targetModelId: parsed.target,
              reason: parsed.reason,
              continuationPrompt: prompt,
            },
            state,
            deps,
          );
        }, 100);

        const targetDisplay = config.models[parsed.target]?.displayName ?? parsed.target;
        return textResult(
          `Switching to ${targetDisplay}. Work will resume automatically on the new model. ` +
            `Do not send further messages until the switch completes.`,
        );
      },
    }));

    // --- Tool: model_info ---
    api.registerTool({
      name: "model_info",
      label: "Model Info",
      description: "Query available models, current status, and capabilities.",
      parameters: modelInfoParameters,
      async execute(_toolCallId, params) {
        const parsed = params as ModelInfoParams;

        if (parsed.action === "status") {
          const modelId = state.activeModelId ?? "unknown";
          const entry = state.activeModelId ? config.models[state.activeModelId] : null;
          return textResult(
            JSON.stringify(
              {
                activeModel: modelId,
                displayName: entry?.displayName ?? "Unknown",
                contextWindow: entry?.contextWindow,
                nativeContextWindow: entry?.nativeContextWindow,
                capabilities: entry?.capabilities ?? [],
                switching: state.switching,
              },
              null,
              2,
            ),
          );
        }

        if (parsed.action === "list") {
          const models = Object.entries(config.models).map(([id, entry]) => ({
            id,
            displayName: entry.displayName,
            active: id === state.activeModelId,
            capabilities: entry.capabilities ?? [],
            contextWindow: entry.contextWindow,
            nativeContextWindow: entry.nativeContextWindow,
            description: entry.description,
          }));
          return textResult(JSON.stringify(models, null, 2));
        }

        if (parsed.action === "capabilities") {
          const targetId = parsed.model ?? state.activeModelId;
          if (!targetId || !(targetId in config.models)) {
            return textResult(
              `ERROR: Model "${targetId ?? "none"}" not found. Available: ${Object.keys(config.models).join(", ")}`,
            );
          }
          const entry = config.models[targetId];
          return textResult(
            JSON.stringify(
              {
                id: targetId,
                ...entry,
                active: targetId === state.activeModelId,
              },
              null,
              2,
            ),
          );
        }

        return textResult(
          `ERROR: Unknown action "${String(parsed.action)}". Use status, list, or capabilities.`,
        );
      },
    });

    // --- Hook: before_agent_reply (gate during switch) ---
    api.on(
      "before_agent_reply",
      async () => {
        if (!state.switching || !state.switchPromise) {
          return undefined;
        }

        // Hold the request until the switch completes
        api.logger.info("[model-switch] Gate: holding request during model switch...");
        await state.switchPromise;
        api.logger.info("[model-switch] Gate: switch complete, releasing request.");

        // Return undefined = don't intercept, let the request proceed to the new model
        return undefined;
      },
      { priority: -100 },
    );

    // --- Hook: before_prompt_build (inject model awareness) ---
    api.on("before_prompt_build", () => {
      if (!state.activeModelId) {
        return undefined;
      }
      const entry = config.models[state.activeModelId];
      if (!entry) {
        return undefined;
      }

      const otherModels = Object.entries(config.models)
        .filter(([id]) => id !== state.activeModelId)
        .map(([id, m]) => `- ${m.displayName} (${id}): ${m.capabilities?.join(", ") ?? "general"}`)
        .join("\n");

      const awareness = [
        `You are running on ${entry.displayName} (${state.activeModelId}).`,
        entry.capabilities?.length ? `Strengths: ${entry.capabilities.join(", ")}.` : "",
        entry.contextWindow
          ? `Context window: ${(entry.contextWindow / 1024).toFixed(0)}K tokens.`
          : "",
        otherModels ? `\nOther available models (use model_switch to switch):\n${otherModels}` : "",
        "\nSwitch models when a task clearly needs capabilities you lack. Include a detailed continuationPrompt.",
      ]
        .filter(Boolean)
        .join(" ");

      return { prependSystemContext: awareness };
    });

    // --- Commands: /switch and /models (bypass tool pipeline, work in all channels) ---
    api.registerCommand({
      name: "switch",
      description: "Switch the active inference model. Usage: /switch <model-id>",
      acceptsArgs: true,
      async handler(ctx) {
        const args = (ctx.args ?? "").trim();
        if (!args) {
          const available = Object.entries(config.models)
            .map(([id, m]) => `  ${id === state.activeModelId ? "→" : " "} ${id}: ${m.displayName}`)
            .join("\n");
          return { text: `Usage: /switch <model-id>\n\nAvailable models:\n${available}` };
        }

        const targetId = args.split(/\s+/)[0] ?? "";
        if (!(targetId in config.models)) {
          return {
            text: `Unknown model "${targetId}". Available: ${Object.keys(config.models).join(", ")}`,
          };
        }

        if (targetId === state.activeModelId) {
          return { text: `Already running on ${targetId}.` };
        }

        if (state.switching) {
          return { text: "A model switch is already in progress." };
        }

        state.switching = true;
        state.switchPromise = new Promise<boolean>((resolve) => {
          resolveSwitchPromise = () => resolve(true);
        });

        const sessionKey = ctx.sessionKey;
        const prompt = args.includes(" ")
          ? args.slice(targetId.length).trim()
          : "Continue with any remaining work.";

        setTimeout(() => {
          void executeSwitch(
            {
              sessionKey: sessionKey ?? "",
              targetModelId: targetId,
              reason: "User-initiated via /switch command",
              continuationPrompt: prompt,
            },
            state,
            deps,
          );
        }, 100);

        const targetDisplay = config.models[targetId]?.displayName ?? targetId;
        return { text: `Switching to ${targetDisplay}...` };
      },
    });

    api.registerCommand({
      name: "switch-list",
      description:
        "Show available switchable models and current status. Different from /models which shows provider model catalog.",
      async handler() {
        const lines = Object.entries(config.models).map(([id, m]) => {
          const active = id === state.activeModelId ? " (ACTIVE)" : "";
          const caps = m.capabilities?.join(", ") ?? "";
          const ctx = m.contextWindow ? ` ${(m.contextWindow / 1024).toFixed(0)}K ctx` : "";
          return `${id}${active}: ${m.displayName} — ${caps}${ctx}`;
        });
        return {
          text: `Models:\n${lines.join("\n")}\n\nSwitch: /switch <model-id>`,
        };
      },
    });

    // --- Service: model-switch-startup (detect active model + recover markers) ---
    api.registerService({
      id: "model-switch-startup",
      async start(ctx) {
        // Detect which model is currently active
        const activeId = await detectActiveModel(config.models);
        if (activeId) {
          state.activeModelId = activeId;
          ctx.logger.info(`[model-switch] Detected active model: ${activeId}`);
        } else {
          state.activeModelId = config.defaultModel || null;
          ctx.logger.warn(
            `[model-switch] No active model detected. Defaulting to: ${state.activeModelId ?? "none"}`,
          );
        }

        // Check for interrupted switches
        await recoverFromMarker(state, deps);
      },
    });
  },
});

function textResult(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    details: null,
  };
}
