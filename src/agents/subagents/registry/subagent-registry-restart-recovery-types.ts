import type { GatewayRecoveryRuntime } from "../../../gateway/server-instance-runtime.types.js";
import type {
  SubagentRecoveryCurrent,
  SubagentRunRecord,
  SubagentSessionEffects,
} from "./subagent-registry.types.js";

export type RestartRecoveryResult =
  | { status: "ignored" }
  | { status: "handled"; retained?: { isCurrent: () => boolean; released?: Promise<void> } }
  | { status: "deferred" }
  | {
      status: "terminal";
      recoveryCurrent?: SubagentRecoveryCurrent;
      sessionEffects?: SubagentSessionEffects;
      error: string;
      endedAt?: number;
      suppressSessionEffects?: boolean;
    };

export type RestartRecoveryParams = {
  runId: string;
  entry: SubagentRunRecord;
  gatewayRuntime: GatewayRecoveryRuntime | undefined;
  isCurrent: (runId: string, entry: SubagentRunRecord) => boolean;
  isGatewayCurrent?: () => boolean;
  warn: (message: string, meta?: Record<string, unknown>) => void;
};
