import type { ExecAsk, ExecSecurity } from "../infra/exec-approvals.js";
import type { ExecElevatedDefaults } from "./bash-tools.exec-types.js";

export type ExecuteNodeHostCommandParams = {
  command: string;
  workdir: string | undefined;
  env: Record<string, string>;
  requestedEnv?: Record<string, string>;
  requestedNode?: string;
  boundNode?: string;
  sessionKey?: string;
  turnSourceChannel?: string;
  turnSourceTo?: string;
  turnSourceAccountId?: string;
  turnSourceThreadId?: string | number;
  trigger?: string;
  agentId?: string;
  security: ExecSecurity;
  ask: ExecAsk;
  strictInlineEval?: boolean;
  timeoutSec?: number;
  defaultTimeoutSec: number;
  approvalRunningNoticeMs: number;
  warnings: string[];
  notifySessionKey?: string;
  notifyOnExit?: boolean;
  trustedSafeBinDirs?: ReadonlySet<string>;
  /**
   * Elevated-tool defaults captured from the originating turn. Forwarded to
   * the followup target so the spawned agent run after `/approve` keeps the
   * same `tools.elevated` availability (default level "ask" still requires a
   * fresh approval per command).
   */
  bashElevated?: ExecElevatedDefaults;
};
