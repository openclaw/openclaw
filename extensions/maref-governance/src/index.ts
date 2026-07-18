/**
 * @openclaw/maref-governance — MAREF Governance Plugin for OpenClaw
 *
 * Intercepts file writes, command execution, and sensitive file reads
 * to enforce policies via an external MAREF sidecar.
 *
 * 安装:
 *   在 OpenClaw 配置中启用本 extension 并确保 MAREF sidecar 运行。
 *
 * 设计原则:
 *   - enforcing 模式: block verdict 阻止操作
 *   - advisory 模式: 只警告不拦截，用于灰度验证
 *   - logging 模式: 只记日志，零拦截
 *   - fail-closed: sidecar 不可达时 enforcing 模式默认阻断
 */

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { MAREFClient, type GateDecision } from "@maref-org/sdk";
import type { PluginHookBeforeToolCallResult } from "openclaw/plugin-sdk/types";

// ── 类型定义 ─────────────────────────────────────────────────────────

type MAREFMode = "enforcing" | "advisory" | "logging";

interface MAREFConfig {
  sidecarUrl?: string;
  mode?: MAREFMode;
  failClosed?: boolean;
}

// ── 工具 ─────────────────────────────────────────────────────────────

/** 从 tool call params 中提取文件路径 */
function extractFilePath(params: Record<string, unknown>): string | null {
  // 常见文件写入工具的路径参数
  const pathKeys = ["file_path", "path", "filePath", "filename", "destination"];
  for (const key of pathKeys) {
    const val = params[key];
    if (typeof val === "string" && val.length > 0) return val;
  }
  return null;
}

/** 从 tool call params 中提取命令 */
function extractCommand(params: Record<string, unknown>): string | null {
  const cmdKeys = ["command", "cmd", "shell", "exec"];
  for (const key of cmdKeys) {
    const val = params[key];
    if (typeof val === "string" && val.length > 0) return val;
  }
  return null;
}

// ── Plugin 入口 ──────────────────────────────────────────────────────

export default definePluginEntry({
  id: "maref-governance",
  name: "MAREF Governance",
  description: "AI agent safety enforcement with fail-closed guardrails via MAREF sidecar",

  register(api) {
    const config = (api.pluginConfig ?? {}) as MAREFConfig;
    const mode: MAREFMode = config.mode ?? "enforcing";
    const failClosed = config.failClosed ?? true;
    const sidecarUrl = config.sidecarUrl ?? "http://localhost:8000";

    const client = new MAREFClient(sidecarUrl);

    /**
     * 单一决策解析 — 根据模式和决策结果决定是否放行
     */
    function resolveDecision(
      decision: GateDecision,
      operation: string,
    ): PluginHookBeforeToolCallResult {
      if (!decision || !decision.verdict) {
        // 无有效决策时 enforcing 模式默认阻断
        if (mode === "enforcing" && failClosed) {
          return {
            block: true,
            blockReason: `[MAREF] No valid decision for ${operation}`,
          };
        }
        return {};
      }
      switch (mode) {
        case "logging":
          return {}; // 放行

        case "advisory": {
          if (decision.verdict === "block") {
            console.warn(
              `[MAREF] ADVISORY — would BLOCK ${operation}: ${decision.reason}`,
            );
          }
          return {}; // 放行
        }

        case "enforcing":
        default: {
          if (decision.verdict === "block") {
            const reason = `[MAREF] BLOCKED ${operation} — rule ${decision.rule_id}: ${decision.reason}`;
            if (failClosed) {
              return {
                block: true,
                blockReason: reason,
              };
            }
            console.warn(`[MAREF] FAIL-OPEN: ${reason}`);
            return {}; // 放行
          }

          if (decision.verdict === "hitl_required") {
            return {
              block: true,
              blockReason: `[MAREF] HITL required for ${operation} — contact human operator`,
            };
          }

          return {}; // 放行
        }
      }
    }

    /**
     * 审计上报（best-effort）
     */
    function reportAction(
      hook: string,
      decision: GateDecision,
      extra: Record<string, unknown>,
    ): void {
      if (!decision) return;
      client.reportAction({
        action: `openclaw:${hook}`,
        result: {
          verdict: decision.verdict,
          rule_id: decision.rule_id,
          reason: decision.reason,
          risk_score: decision.risk_score,
          ...extra,
        },
      }).catch(() => {
        // 审计上报是 best-effort
      });
    }

    // ── 注册 Hook: before_tool_call ────────────────────────────────
    //
    // 拦截文件写入和执行类工具调用，在允许执行前向 MAREF sidecar 发起治理检查。

    api.registerHook("before_tool_call", async (event, ctx) => {
      // logging 模式：完全跳过所有 sidecar 检查
      if (mode === "logging") {
        return {};
      }

      const filePath = extractFilePath(event.params);
      const command = extractCommand(event.params);

      // 不是文件操作或命令执行，放行
      if (!filePath && !command) {
        return {};
      }

      try {
        if (filePath) {
          // 文件写入检查
          const decision = await client.checkBeforeWrite({
            file_path: filePath,
            actor: ctx.agentId ?? "openclaw-agent",
            session_id: ctx.sessionId,
          });

          reportAction("before_tool_call", decision, {
            filePath,
            toolName: event.toolName,
          });

          return resolveDecision(decision, `write ${filePath}`);
        }

        if (command) {
          // 命令执行检查
          const decision = await client.checkBeforeExecute({
            command,
            actor: ctx.agentId ?? "openclaw-agent",
            session_id: ctx.sessionId,
          });

          reportAction("before_tool_call", decision, {
            command,
            toolName: event.toolName,
          });

          return resolveDecision(decision, `execute ${command}`);
        }
      } catch (err) {
        // sidecar 不可达
        if (failClosed && mode === "enforcing") {
          return {
            block: true,
            blockReason: `[MAREF] FAIL-CLOSED: Sidecar unreachable: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
        console.warn(`[MAREF] Sidecar error (fail-open): ${err}`);
        return {};
      }

      return {};
    });

    // ── 注册安全审计收集器 ────────────────────────────────────────

    api.registerSecurityAuditCollector({
      collectorId: "maref-governance",
      label: "MAREF Governance",
      collect: async () => {
        try {
          const status = await client.getGovernanceStatus();
          return {
            status: "ok",
            data: {
              governance_state: status.state,
              circuit_breaker: status.circuit_breaker,
              trust_score_avg: status.trust_score_avg,
              drift_level: status.drift_level,
            },
          };
        } catch {
          return {
            status: "error",
            data: { error: "MAREF sidecar unreachable" },
          };
        }
      },
    });
  },
});
