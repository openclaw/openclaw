import type { ExecTarget } from "../infra/exec-approvals.js";

/** Returns true when a per-call target override is allowed by configured policy. */
export function isRequestedExecTargetAllowed(params: {
  configuredTarget: ExecTarget;
  requestedTarget: ExecTarget;
  sandboxAvailable?: boolean;
}) {
  return (
    params.requestedTarget === params.configuredTarget ||
    (params.configuredTarget === "auto" &&
      (!params.sandboxAvailable ||
        (params.requestedTarget !== "gateway" && params.requestedTarget !== "node")))
  );
}
