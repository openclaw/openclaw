import type { CautionContext } from "../security/caution-context.js";
import { runCautionAudit } from "../security/caution-auditor.js";
import { isToolCautioned } from "../security/caution-defaults.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { normalizeToolName } from "./tool-policy.js";
import type { AnyAgentTool } from "./tools/common.js";

const log = createSubsystemLogger("security/caution");

function summarizeParams(params: unknown): string {
  if (!params || typeof params !== "object") return "";
  const entries = Object.entries(params as Record<string, unknown>);
  return entries
    .map(([k, v]) => {
      if (typeof v === "string" && v.length > 80) return `${k}=[${v.length} chars]`;
      if (typeof v === "string") return `${k}="${v}"`;
      return `${k}=${JSON.stringify(v)}`;
    })
    .join(", ");
}

export function wrapToolWithCautionAudit(
  tool: AnyAgentTool,
  ctx: CautionContext,
): AnyAgentTool {
  const execute = tool.execute;
  if (!execute) return tool;

  const toolName = normalizeToolName(tool.name || "tool");

  return {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate) => {
      // --- PRE-EXECUTION: audit if taint is active ---
      if (ctx.isCautionTainted()) {
        const audit = await runCautionAudit(
          {
            originalUserMessage: ctx.getOriginalUserMessage(),
            sourceToolName: ctx.getLastCautionedToolName(),
            proposedToolName: toolName,
            proposedParamsSummary: summarizeParams(params),
          },
          {
            model: ctx.auditorModel,
            modelRegistry: ctx.modelRegistry,
            timeoutMs: ctx.auditorOptions.timeoutMs,
            failMode: ctx.auditorOptions.failMode,
            signal,
          },
        );

        if (audit.decision === "block") {
          log.warn(
            `caution audit BLOCKED: source=${ctx.getLastCautionedToolName()} ` +
              `proposed=${toolName} reason=${audit.reason} durationMs=${audit.durationMs}`,
          );
          ctx.onAuditBlock(toolName, audit.reason);
          throw new Error(
            `Caution Mode blocked ${toolName}: ${audit.reason ?? "action not aligned with user request"}`,
          );
        }

        log.debug(
          `caution audit allowed: source=${ctx.getLastCautionedToolName()} ` +
            `proposed=${toolName} durationMs=${audit.durationMs}`,
        );
      }

      // --- EXECUTE the tool normally ---
      const result = await execute(toolCallId, params, signal, onUpdate);

      // --- POST-EXECUTION: set or clear taint ---
      if (isToolCautioned(toolName, ctx.cautionConfig)) {
        ctx.setCautionTaint(toolName);
      } else {
        ctx.clearCautionTaint();
      }

      return result;
    },
  };
}
