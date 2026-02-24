import type { ExecApprovalDecision } from "../infra/exec-approvals.js";
import type { OpenClawConfig } from "../config/types.js";
import type { ExecAsk, ExecHost, ExecSecurity, ExecTarget } from "../infra/exec-approvals.js";
import type { SafeBinProfileFixture } from "../infra/exec-safe-bin-policy.js";
import type { BashSandboxConfig } from "./bash-tools.shared.js";
import type { EmbeddedFullAccessBlockedReason } from "./pi-embedded-runner/types.js";

export type RubberBandDefaults = {
  enabled?: boolean;
  mode?: "block" | "alert" | "log" | "off" | "shadow";
  thresholds?: {
    alert?: number;
    block?: number;
  };
  allowedDestinations?: string[];
  notifyChannel?: boolean;
};

export type ExecToolDefaults = {
  hasCronTool?: boolean;
  host?: ExecTarget;
  security?: ExecSecurity;
  ask?: ExecAsk;
  trigger?: string;
  node?: string;
  pathPrepend?: string[];
  safeBins?: string[];
  strictInlineEval?: boolean;
  safeBinTrustedDirs?: string[];
  safeBinProfiles?: Record<string, SafeBinProfileFixture>;
  agentId?: string;
  backgroundMs?: number;
  timeoutSec?: number;
  approvalRunningNoticeMs?: number;
  sandbox?: BashSandboxConfig;
  elevated?: ExecElevatedDefaults;
  allowBackground?: boolean;
  scopeKey?: string;
  sessionKey?: string;
  messageProvider?: string;
  currentChannelId?: string;
  currentThreadTs?: string;
  accountId?: string;
  notifyOnExit?: boolean;
  notifyOnExitEmptySuccess?: boolean;
  cwd?: string;
  rubberband?: RubberBandDefaults;
  cfg?: OpenClawConfig;
};

export type ExecElevatedDefaults = {
  enabled: boolean;
  allowed: boolean;
  defaultLevel: "on" | "off" | "ask" | "full";
  fullAccessAvailable?: boolean;
  fullAccessBlockedReason?: EmbeddedFullAccessBlockedReason;
};

export type ExecToolDetails =
  | {
      status: "running";
      sessionId: string;
      pid?: number;
      startedAt: number;
      cwd?: string;
      tail?: string;
    }
  | {
      status: "completed" | "failed";
      exitCode: number | null;
      durationMs: number;
      aggregated: string;
      timedOut?: boolean;
      cwd?: string;
    }
  | {
      status: "approval-pending";
      approvalId: string;
      approvalSlug: string;
      expiresAtMs: number;
      allowedDecisions?: readonly ExecApprovalDecision[];
      host: ExecHost;
      command: string;
      cwd?: string;
      nodeId?: string;
      warningText?: string;
    }
  | {
      status: "approval-unavailable";
      reason:
        | "initiating-platform-disabled"
        | "initiating-platform-unsupported"
        | "no-approval-route";
      channel?: string;
      channelLabel?: string;
      accountId?: string;
      sentApproverDms?: boolean;
      host: ExecHost;
      command: string;
      cwd?: string;
      nodeId?: string;
      warningText?: string;
    };
