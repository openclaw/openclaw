import { AgentHarnessPreflightError } from "./harness/errors.js";

/** Host-stamped input authority. Never accept this field from message text or RPC parameters. */
export type ParticipationCeiling = Readonly<{
  kind: "send";
  profileId: string;
  sessionKey: string;
}>;

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
