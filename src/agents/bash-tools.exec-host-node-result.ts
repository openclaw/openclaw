import { renderExecUpdateText } from "./bash-tools.exec-output.js";
import type { ExecToolDetails } from "./bash-tools.exec-types.js";
import type { AgentToolResult } from "./runtime/index.js";

function formatFailedNodeRunToolResult(params: {
  aggregated: string;
  cwd: string | undefined;
  durationMs: number;
  errorText: string;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | number | null;
  stderr: string;
  timedOut: boolean;
  warnings?: string[];
}): AgentToolResult<ExecToolDetails> {
  return {
    content: [
      {
        type: "text",
        text: renderExecUpdateText({
          tailText: params.aggregated,
          warnings: params.warnings ?? [],
        }),
      },
    ],
    details: {
      status: "failed",
      exitCode: params.exitCode,
      exitSignal: params.exitSignal,
      durationMs: params.durationMs,
      aggregated: params.aggregated,
      timedOut: params.timedOut,
      failureKind: params.timedOut ? "overall-timeout" : "node-run-failed",
      failureReason: params.errorText || params.stderr || undefined,
      cwd: params.cwd,
    },
  };
}

export function formatNodeRunPayloadToolResult(params: {
  payloadObj: Record<string, unknown>;
  startedAt: number;
  cwd: string | undefined;
  warnings?: string[];
}): AgentToolResult<ExecToolDetails> {
  const stdout = typeof params.payloadObj.stdout === "string" ? params.payloadObj.stdout : "";
  const stderr = typeof params.payloadObj.stderr === "string" ? params.payloadObj.stderr : "";
  const errorText = typeof params.payloadObj.error === "string" ? params.payloadObj.error : "";
  const success =
    typeof params.payloadObj.success === "boolean" ? params.payloadObj.success : false;
  const exitCode =
    typeof params.payloadObj.exitCode === "number" ? params.payloadObj.exitCode : null;
  const exitSignal =
    typeof params.payloadObj.exitSignal === "string" ||
    typeof params.payloadObj.exitSignal === "number"
      ? (params.payloadObj.exitSignal as NodeJS.Signals | number)
      : null;
  const timedOut = params.payloadObj.timedOut === true;
  const aggregated = [stdout, stderr, errorText].filter(Boolean).join("\n");
  const durationMs = Date.now() - params.startedAt;
  if (!success) {
    return formatFailedNodeRunToolResult({
      aggregated,
      cwd: params.cwd,
      durationMs,
      errorText,
      exitCode,
      exitSignal,
      stderr,
      timedOut,
      warnings: params.warnings,
    });
  }
  return {
    content: [
      {
        type: "text",
        text: renderExecUpdateText({ tailText: aggregated, warnings: params.warnings ?? [] }),
      },
    ],
    details: {
      status: "completed",
      exitCode,
      durationMs,
      aggregated,
      cwd: params.cwd,
    } satisfies ExecToolDetails,
  };
}
