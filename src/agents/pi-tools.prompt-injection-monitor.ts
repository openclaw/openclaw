import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../config/config.js";
import type { AnyAgentTool } from "./pi-tools.types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { extractToolResultText } from "./pi-embedded-subscribe.tools.js";
import {
  createRedactedToolResult,
  createWarningToolResult,
  getPiMonitorAction,
  isPiMonitorEnabled,
  logIncident,
  PROMPT_INJECTION_THRESHOLD,
  scoreForPromptInjection,
} from "./prompt-injection-monitor.js";
import { jsonResult } from "./tools/common.js";

const log = createSubsystemLogger("agents/prompt-injection-monitor");

const MIN_TEXT_LENGTH = 50;

export type MonitorState = {
  skipNext: boolean;
  cfg?: OpenClawConfig;
};

export function createMonitorState(cfg?: OpenClawConfig): MonitorState {
  return { skipNext: false, cfg };
}

export function wrapToolWithPromptInjectionMonitor(
  tool: AnyAgentTool,
  state: MonitorState,
): AnyAgentTool {
  if (tool.name === "disable_pi_monitor") {
    return tool;
  }
  if (!isPiMonitorEnabled(state.cfg)) {
    return tool;
  }
  if (!state.cfg) {
    return tool;
  }
  const execute = tool.execute;
  if (!execute) {
    return tool;
  }
  const toolName = tool.name || "tool";
  const action = getPiMonitorAction(state.cfg);

  return {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate) => {
      const result = await execute(toolCallId, params, signal, onUpdate);

      const bypassing = state.skipNext;
      if (bypassing) {
        state.skipNext = false;
      }

      const text = extractToolResultText(result);
      if (!text || text.length < MIN_TEXT_LENGTH) {
        return result;
      }

      try {
        const { score, reasoning } = await scoreForPromptInjection(text, toolName, state.cfg!);

        if (score >= PROMPT_INJECTION_THRESHOLD) {
          // Log incident to file (with bypass flag)
          logIncident(state.cfg!, toolName, score, reasoning, action, bypassing);

          if (bypassing) {
            log.warn(
              `Prompt injection detected in tool "${toolName}" (score: ${score}/100) but BYPASSED by user: ${reasoning}`,
            );
            return result;
          }

          log.warn(
            `Prompt injection detected in tool "${toolName}" (score: ${score}/100): ${reasoning}`,
          );

          switch (action) {
            case "block":
              return createRedactedToolResult(toolName, score) as typeof result;

            case "warn": {
              // Return original content with warning prepended
              const warnedText = createWarningToolResult(text, toolName, score, reasoning);
              return {
                content: [{ type: "text", text: warnedText }],
              } as typeof result;
            }

            case "log":
              // Just log, don't modify the result
              return result;
          }
        }

        return result;
      } catch (err) {
        log.warn(`Prompt injection scoring failed for tool "${toolName}": ${String(err)}`);
        // Fail closed: redact on error (only if action is block)
        if (action === "block") {
          return createRedactedToolResult(toolName, -1) as typeof result;
        }
        return result;
      }
    },
  };
}

export function createDisablePiMonitorTool(state: MonitorState): AnyAgentTool {
  return {
    name: "disable_pi_monitor",
    label: "Disable PI Monitor",
    description:
      "Disables prompt injection monitoring for the next tool call only. Use when the user has reviewed a redacted result and confirmed it is safe. The bypass is consumed after one tool execution.",
    parameters: Type.Object({}),
    execute: async () => {
      state.skipNext = true;
      return jsonResult({
        ok: true,
        message: "Prompt injection monitoring disabled for the next tool call.",
      });
    },
  };
}
