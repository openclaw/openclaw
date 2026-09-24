import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import type { GatewayMatrixTrace } from "./code-mode-matrix-gateway.ts";

export type MatrixPerformanceEvaluation = {
  workspace: string;
  trace: GatewayMatrixTrace;
  receipts: readonly unknown[];
  taskResponseAt?: number;
  taskRecords?: readonly unknown[];
};

/** Mode-neutral inputs and outcome checks shared by both treatment arms. */
export type MatrixPerformanceFixture = {
  prompt: string;
  rubricVersion: string;
  pluginSource?: string;
  requiredTools: readonly string[];
  allowedTools: readonly string[];
  deliveredFiles: readonly string[];
  workspaceFiles?: Record<string, string>;
  configPatch?: OpenClawConfig;
  inspectSubagents?: boolean;
  evaluate: (params: MatrixPerformanceEvaluation) => Promise<Record<string, boolean>>;
};
