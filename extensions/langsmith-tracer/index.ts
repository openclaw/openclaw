/**
 * LangSmith Tracer — OpenClaw fork extension.
 *
 * Traces every agent turn to LangSmith using the OpenClaw plugin hook system.
 * No core files are modified; this extension is entirely additive.
 *
 * ## Quick enable
 *
 *   export LANGSMITH_API_KEY=ls__...
 *   export LANGSMITH_PROJECT=openclaw          # optional, default: "default"
 *   export LANGSMITH_TRACING_V2=true           # required by LangSmith
 *
 * Then add to your openclaw.yml:
 *
 *   plugins:
 *     entries:
 *       langsmith-tracer:
 *         enabled: true
 *
 * ## Architecture
 *
 * See extensions/langsmith-tracer/src/tracer.ts for the RunTree state machine
 * and extensions/langsmith-tracer/README.md for the full reference.
 *
 * ## Correlation key
 *
 * Agent hooks (before_agent_start, llm_input, llm_output, agent_end) carry
 * PluginHookAgentContext with sessionId + agentId.
 * Tool hooks (before_tool_call, after_tool_call) carry PluginHookToolContext
 * with agentId only (no sessionId). We use agentId as the primary key so tool
 * events can be correlated to their parent agent session.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { buildClient, isEnabled, resolveConfig } from "./src/config.js";
import { LangSmithTracer } from "./src/tracer.js";

export default {
  id: "langsmith-tracer",
  name: "LangSmith Tracer",
  description:
    "Traces OpenClaw agent runs (LLM calls, tool calls, token usage) to LangSmith. " +
    "Enable by setting LANGSMITH_API_KEY. No-op when the key is absent.",

  register(api: OpenClawPluginApi) {
    const pluginCfg = api.pluginConfig as Record<string, unknown> | undefined;

    if (!isEnabled(pluginCfg)) {
      api.logger.info(
        "langsmith-tracer: LANGSMITH_API_KEY not set — tracing disabled (set the env var to enable)",
      );
      return;
    }

    const cfg = resolveConfig(pluginCfg);
    const client = buildClient(cfg);
    const tracer = new LangSmithTracer({
      client,
      projectName: cfg.project,
      logger: api.logger,
    });

    api.logger.info(
      `langsmith-tracer: tracing enabled → project "${cfg.project}" at ${cfg.endpoint}`,
    );

    // ── before_agent_start ──────────────────────────────────────────────────
    // Creates the root "chain" run for the full agent turn.
    // Correlation key: agentId (stable across agent + tool hooks).
    api.on("before_agent_start", async (event, ctx) => {
      const key = ctx.agentId ?? ctx.sessionId ?? "unknown";
      await tracer.onAgentStart(key, event);
    });

    // ── llm_input ───────────────────────────────────────────────────────────
    // Creates a child "llm" run for each LLM API call within the turn.
    api.on("llm_input", async (event, ctx) => {
      const key = ctx.agentId ?? event.sessionId ?? "unknown";
      await tracer.onLlmInput(key, event);
    });

    // ── before_tool_call ────────────────────────────────────────────────────
    // Creates a grandchild "tool" run under the current LLM run.
    api.on("before_tool_call", async (event, ctx) => {
      const key = ctx.agentId ?? "unknown";
      await tracer.onBeforeToolCall(key, event);
    });

    // ── after_tool_call ─────────────────────────────────────────────────────
    // Closes the tool run with its result or error.
    api.on("after_tool_call", async (event, ctx) => {
      const key = ctx.agentId ?? "unknown";
      await tracer.onAfterToolCall(key, event);
    });

    // ── llm_output ──────────────────────────────────────────────────────────
    // Closes the LLM run with texts + token usage.
    api.on("llm_output", async (event, ctx) => {
      const key = ctx.agentId ?? event.sessionId ?? "unknown";
      await tracer.onLlmOutput(key, event);
    });

    // ── agent_end ───────────────────────────────────────────────────────────
    // Closes the root run and removes the session from the state map.
    api.on("agent_end", async (event, ctx) => {
      const key = ctx.agentId ?? ctx.sessionId ?? "unknown";
      await tracer.onAgentEnd(key, event);
    });
  },
};
