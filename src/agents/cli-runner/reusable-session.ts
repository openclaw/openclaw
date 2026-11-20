import { resolveCliSessionReuse } from "../cli-session.js";
import type { CliReusableSession, RunCliAgentParams } from "./types.js";

// A fork reads the source session's native history, so that session's account and cwd boundary
// applies. Its own process and exact tool grant may differ from the source turns' topology.
const FORK_REFUSED_REUSE = new Set(["auth-profile", "auth-epoch", "cwd"]);

/**
 * The native session a run may resume. Ordinary turns check the stored binding against the run's
 * auth, prompt, policy and MCP facts. Native controls target the already-owned transcript without
 * rebuilding its turn-time MCP topology: re-validating it would discard the session being
 * compacted. A session fork refuses a binding outside the source's account or cwd.
 */
export function resolveCliReusableSessionCandidate(params: {
  run: Pick<RunCliAgentParams, "controlOperation" | "cliSessionBinding" | "cliSessionId">;
  backendId: string;
  /** `sessionMode: none`: no returned or stored id is authority for cross-process continuity. */
  stateless: boolean;
  facts: Omit<Parameters<typeof resolveCliSessionReuse>[0], "binding">;
}): CliReusableSession {
  const { run } = params;
  const binding = run.cliSessionBinding;
  const checked =
    binding && run.controlOperation !== "compact"
      ? resolveCliSessionReuse({ binding, ...params.facts })
      : undefined;
  if (run.controlOperation === "fork") {
    const refusal =
      !checked || checked.mode === "none"
        ? "no native session binding"
        : checked.mode === "invalidate" && FORK_REFUSED_REUSE.has(checked.invalidatedReason)
          ? checked.invalidatedReason
          : undefined;
    if (refusal) {
      throw new Error(
        `CLI backend ${params.backendId} cannot fork this session: its native session is not reusable (${refusal}).`,
      );
    }
  }
  const controlSessionId = run.controlOperation
    ? binding?.sessionId?.trim() || run.cliSessionId?.trim()
    : undefined;
  if (params.stateless) {
    return { mode: "none" };
  }
  if (controlSessionId) {
    return { mode: "reuse", sessionId: controlSessionId };
  }
  return (
    checked ??
    (run.cliSessionId ? { mode: "reuse", sessionId: run.cliSessionId } : { mode: "none" })
  );
}
