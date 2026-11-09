import type { GatewayLogSentinelFinding } from "./gateway-log-sentinel.js";
import type { RuntimeId } from "./runtime-id.js";
import type { RuntimeParityCacheDiagnostics } from "./runtime-parity-cache-diagnostics.js";
import type { RuntimeParityUsage } from "./runtime-parity-usage.js";

export type RuntimeParityStatus = "pass" | "fail" | "skip";

export type RuntimeParityToolCall = {
  tool: string;
  argsHash: string;
  resultHash: string;
  errorClass?: string;
};

export type RuntimeParityUsagePolicy =
  | { expectation: "assistant-message-required" }
  | { expectation: "not-applicable"; reason: string };

export type RuntimeParityCell = {
  runtime: RuntimeId;
  transcriptBytes: string;
  toolCalls: RuntimeParityToolCall[];
  providerPlanToolCalls?: RuntimeParityToolCall[];
  finalText: string;
  usage: RuntimeParityUsage;
  cacheDiagnostics?: RuntimeParityCacheDiagnostics;
  wallClockMs: number;
  bootstrapWallClockMs?: number;
  transportErrorClass?: string;
  runtimeErrorClass?: string;
  bootStateLines: string[];
  sentinelFindings?: GatewayLogSentinelFinding[];
  modelSwitchEvidence?: Record<string, unknown>;
};

export type RuntimeParityResultCell = RuntimeParityCell & {
  status: RuntimeParityStatus;
  details?: string;
};

export type RuntimeParityDrift =
  | "none"
  | "text-only"
  | "tool-call-shape"
  | "tool-result-shape"
  | "structural"
  | "failure-mode";

export type RuntimeParityResult = {
  scenarioId: string;
  runtimeParityUsage?: RuntimeParityUsagePolicy;
  cells: Record<RuntimeId, RuntimeParityResultCell>;
  drift: RuntimeParityDrift;
  driftDetails?: string;
};

export type RuntimeParityScenarioExecution = {
  status: RuntimeParityStatus;
  details?: string;
  cell: RuntimeParityCell;
};
