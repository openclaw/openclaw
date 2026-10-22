import type { ExecAsk, ExecSecurity, ExecTarget } from "../infra/exec-approvals-core.js";

/** Execution routing and approval choices retained by a prepared turn. */
export type ExecToolRoutingDefaults = {
  host?: ExecTarget;
  security?: ExecSecurity;
  ask?: ExecAsk;
  node?: string;
  /** Default working directory for node-host execution only. */
  nodeCwd?: string;
};
