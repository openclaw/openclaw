import { AgentHarnessPreflightError } from "./harness/errors.js";

/** Host-stamped input authority. Never accept this field from message text or RPC parameters. */
export type ParticipationCeiling = {
  readonly kind: "send";
  readonly profileId: string;
  readonly sessionKey: string;
  /** Exact core names captured at admission; omission retains the default for stored inputs. */
  readonly tools?: readonly string[];
};

/** Participation defaults live here; other policy layers may only narrow these capabilities. */
export const PARTICIPATION_EXEC_CEILING = "ask" as const;
export const PARTICIPATION_TOOL_ALLOWLIST = Object.freeze([
  "read",
  "write",
  "edit",
  "apply_patch",
  "ls",
  "exec",
  "process",
  "web_search",
  "web_fetch",
  "tool_search",
  "tool_describe",
  "dispatch_action",
]);

/** Read the admitted tool ceiling without consulting mutable role configuration. */
export function participationToolAllowlist(ceiling: ParticipationCeiling): readonly string[] {
  return ceiling.tools ?? PARTICIPATION_TOOL_ALLOWLIST;
}

export const PARTICIPATION_RUNTIME_ERROR =
  "Participating inputs require the OpenClaw runtime. Select an OpenClaw model and send again.";

export function assertParticipationRuntime(
  ceiling: ParticipationCeiling | undefined,
  runtime: string,
): void {
  if (ceiling && runtime !== "openclaw") {
    throw new AgentHarnessPreflightError(PARTICIPATION_RUNTIME_ERROR, {
      userMessage: PARTICIPATION_RUNTIME_ERROR,
    });
  }
}

export const PARTICIPATION_WORKER_ERROR =
  "Participating inputs require Gateway-local OpenClaw execution. Worker placements cannot enforce their permission ceiling; use a Gateway-local OpenClaw session.";

/** Worker launch protocols do not carry the per-input execution ceiling. */
export function assertParticipationWorkerExecution(
  ceiling: ParticipationCeiling | undefined,
): void {
  if (ceiling) {
    throw new AgentHarnessPreflightError(PARTICIPATION_WORKER_ERROR, {
      userMessage: PARTICIPATION_WORKER_ERROR,
    });
  }
}
