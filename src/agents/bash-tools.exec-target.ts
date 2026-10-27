import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { requireValidExecTarget, type ExecTarget } from "../infra/exec-approvals-core.js";
import type { ExecToolDefaults } from "./bash-tools.exec-types.js";
import { markToolExecutionNotStarted } from "./tool-effect-receipt.js";

export function resolveRequestedExecTarget(params: { host?: unknown; node?: unknown }) {
  const host = requireValidExecTarget(params.host);
  const node = normalizeOptionalString(params.node);
  if (!node) {
    return host;
  }
  if (params.host != null && host !== "node") {
    throw markToolExecutionNotStarted(
      new Error(
        `exec node=${JSON.stringify(node)} conflicts with host=${JSON.stringify(params.host)}; omit host or use host="node" to run on this node.`,
      ),
    );
  }
  return "node";
}

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

/** Resolves configured/requested/elevated exec target into an effective host. */
export function resolveExecTarget(params: {
  configuredTarget?: ExecTarget;
  requestedTarget?: ExecTarget | null;
  elevatedRequested: boolean;
  sandboxAvailable: boolean;
  sandboxRequired?: boolean;
}) {
  const sandboxRequired = params.sandboxRequired === true;
  if (sandboxRequired && !params.sandboxAvailable) {
    throw markToolExecutionNotStarted(
      new Error("This session requires a sandbox, but its sandbox runtime is unavailable."),
    );
  }
  if (sandboxRequired && params.elevatedRequested) {
    throw markToolExecutionNotStarted(
      new Error("Elevated execution is unavailable because this session requires a sandbox."),
    );
  }
  // Session isolation outranks every agent, session, and request-scoped host preference.
  const configuredTarget = sandboxRequired ? "auto" : (params.configuredTarget ?? "auto");
  const requestedTarget =
    params.requestedTarget === "auto" ? null : (params.requestedTarget ?? null);
  if (sandboxRequired && (requestedTarget === "gateway" || requestedTarget === "node")) {
    throw markToolExecutionNotStarted(
      new Error(
        `exec host not allowed (requested ${requestedTarget}; this session requires a sandbox).`,
      ),
    );
  }
  if (
    requestedTarget &&
    !isRequestedExecTargetAllowed({
      configuredTarget,
      requestedTarget,
      sandboxAvailable: params.sandboxAvailable,
    })
  ) {
    const allowedConfig = (
      configuredTarget === "auto" &&
      params.sandboxAvailable &&
      (requestedTarget === "gateway" || requestedTarget === "node")
        ? [requestedTarget]
        : [requestedTarget, "auto"]
    ).join(" or ");
    throw markToolExecutionNotStarted(
      new Error(
        `exec host not allowed (requested ${requestedTarget}; ` +
          `configured host is ${configuredTarget}; ` +
          `set tools.exec.host=${allowedConfig} to allow this override).`,
      ),
    );
  }
  const selectedTarget = requestedTarget ?? configuredTarget;
  const resolvedTarget = params.elevatedRequested
    ? selectedTarget === "node"
      ? "node"
      : "gateway"
    : selectedTarget;
  const effectiveHost =
    resolvedTarget === "auto" ? (params.sandboxAvailable ? "sandbox" : "gateway") : resolvedTarget;
  return {
    configuredTarget,
    requestedTarget,
    selectedTarget: resolvedTarget,
    effectiveHost,
  };
}

// Preparation and execution must interpret elevation identically before host policy runs.
export function resolveExecElevatedMode(
  defaults: ExecToolDefaults | undefined,
  requested: unknown,
) {
  const elevated = defaults?.elevated;
  const defaultMode =
    elevated?.defaultLevel === "full"
      ? "full"
      : elevated?.defaultLevel === "ask" || elevated?.defaultLevel === "on"
        ? "ask"
        : "off";
  if (typeof requested === "boolean") {
    return requested ? (defaultMode === "full" ? "full" : "ask") : "off";
  }
  return elevated?.enabled && elevated.allowed && !defaults?.sandboxRequired ? defaultMode : "off";
}

export function resolveExecHost(
  params: { host?: unknown; node?: unknown; elevated?: unknown },
  defaults?: ExecToolDefaults,
) {
  const elevatedMode = resolveExecElevatedMode(defaults, params.elevated);
  return resolveExecTarget({
    configuredTarget: defaults?.host,
    requestedTarget: resolveRequestedExecTarget(params),
    elevatedRequested: elevatedMode !== "off",
    sandboxAvailable: Boolean(defaults?.sandbox),
    sandboxRequired: defaults?.sandboxRequired,
  }).effectiveHost;
}
