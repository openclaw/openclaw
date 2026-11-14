import {
  WorkerProviderError,
  type WorkerResourceReceipt,
  type WorkerRetentionObservation,
  type WorkerRetentionOperation,
  type WorkerRetentionPolicy,
} from "openclaw/plugin-sdk/plugin-entry";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { runCrabboxProcess } from "./crabbox-process.js";
import { parseCrabboxJson } from "./crabbox-worker-command.js";
import type { parseCrabboxProfile } from "./crabbox-worker-profile.js";
import { CRABBOX_MACHINE_CATALOG_TIMEOUT_MS } from "./crabbox-worker-timeouts.js";

/** Freeze the caller's acquisition choice before any awaited preparation or external effect. */
export function prepareCrabboxRetention(
  profile: ReturnType<typeof parseCrabboxProfile>,
  policy: WorkerRetentionPolicy,
): WorkerRetentionPolicy {
  if (
    profile.provider !== "azure-sandbox" ||
    profile.target !== "linux" ||
    profile.warmImage ||
    policy.version !== 1 ||
    !/^[a-f0-9]{64}$/u.test(policy.ownerBinding) ||
    !Number.isSafeInteger(policy.computeWindowSeconds) ||
    policy.computeWindowSeconds <= 0 ||
    policy.computeWindowSeconds > 9_223_372_036
  ) {
    throw new WorkerProviderError(
      "Crabbox session disk retention requires Linux Azure Sandbox, no warm images, a SHA-256 owner binding, and a finite whole-second compute window",
    );
  }
  return Object.freeze({
    version: 1,
    ownerBinding: policy.ownerBinding,
    computeWindowSeconds: policy.computeWindowSeconds,
  });
}

export async function assertCrabboxRetentionSupport(params: {
  binary: string;
  signal?: AbortSignal;
}): Promise<void> {
  // The complete executable catalog exceeds the lifecycle command's output bound.
  const result = await runCrabboxProcess([params.binary, "providers", "--json"], {
    maxOutputBytes: 1024 * 1024,
    killProcessTree: true,
    timeoutMs: CRABBOX_MACHINE_CATALOG_TIMEOUT_MS,
    ...(params.signal ? { signal: params.signal } : {}),
  });
  params.signal?.throwIfAborted();
  const catalog =
    result.termination === "exit" && result.code === 0
      ? parseCrabboxJson(result.stdout, "providers")
      : undefined;
  const provider = Array.isArray(catalog)
    ? catalog.find((entry) => isRecord(entry) && entry.provider === "azure-sandbox")
    : undefined;
  if (
    !isRecord(provider) ||
    !Array.isArray(provider.targets) ||
    !provider.targets.includes("linux") ||
    !Array.isArray(provider.features) ||
    !provider.features.includes("session-disk-retention-v1") ||
    !provider.features.includes("pause-resume")
  ) {
    throw new WorkerProviderError(
      "Selected Crabbox executable does not advertise Linux Azure Sandbox session-disk-retention-v1 and pause-resume; update Crabbox before retained allocation",
    );
  }
}

function boundedText(value: unknown, limit = 2048): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= limit &&
    value.trim() === value &&
    !/\p{Cc}/u.test(value)
  );
}

export function assertCrabboxRetentionOperation(operation: WorkerRetentionOperation): void {
  if (
    !/^[\x21-\x7e]{1,128}$/u.test(operation.id) ||
    (operation.action !== "pause" && operation.action !== "resume") ||
    !boundedText(operation.expectedClaimRevision)
  ) {
    throw new Error("Invalid Crabbox retained lifecycle operation");
  }
}

/** Decode the released v0.80.0 contract, never treating an incomplete view as runnable. */
export function readCrabboxRetention(
  value: Record<string, unknown>,
  policy: WorkerRetentionPolicy | undefined,
  receipt?: WorkerResourceReceipt,
): WorkerRetentionObservation | undefined {
  const retained = value.retention;
  if (!policy && retained === undefined) {
    return undefined;
  }
  if (!policy) {
    throw new Error(
      "Retained Crabbox allocations require the session-disk lifecycle; adoption refused",
    );
  }
  if (
    value.provider !== "azure-sandbox" ||
    !isRecord(retained) ||
    retained.schema !== "crabbox.session-disk.v1" ||
    retained.mode !== "session-disk" ||
    retained.ownerBinding !== policy.ownerBinding ||
    retained.computeWindowSeconds !== policy.computeWindowSeconds ||
    !boundedText(retained.claimRevision) ||
    typeof retained.policyVerified !== "boolean" ||
    typeof retained.observedState !== "string" ||
    typeof retained.stopPending !== "boolean" ||
    !["running", "suspended", "retired"].includes(String(retained.desiredState))
  ) {
    throw new Error("Crabbox retained policy observation is invalid or owner binding changed");
  }
  const identity = retained.identity;
  if (
    !isRecord(identity) ||
    !boundedText(identity.leaseId, 128) ||
    identity.leaseId !== value.id ||
    identity.attemptLeaseId !== value.id ||
    !boundedText(identity.slug) ||
    !boundedText(identity.resourceId) ||
    (boundedText(value.serverId) && value.serverId !== identity.resourceId) ||
    (boundedText(value.slug) && value.slug !== identity.slug) ||
    (receipt &&
      (receipt.version !== 1 ||
        receipt.leaseId !== identity.leaseId ||
        receipt.identity.provider !== "azure-sandbox" ||
        receipt.identity.resourceId !== identity.resourceId ||
        receipt.identity.slug !== identity.slug))
  ) {
    throw new Error(
      "Crabbox retained resource identity is unavailable or changed; replacement refused",
    );
  }
  const window = retained.computeWindow;
  if (
    !isRecord(window) ||
    !boundedText(window.id) ||
    typeof window.authorizedAt !== "string" ||
    typeof window.expiresAt !== "string" ||
    (window.state !== "active" && window.state !== "closed")
  ) {
    throw new Error("Crabbox retained compute window is invalid");
  }
  const authorizedAtMs = Date.parse(window.authorizedAt);
  const computeExpiresAtMs = Date.parse(window.expiresAt);
  if (
    !Number.isSafeInteger(authorizedAtMs) ||
    authorizedAtMs <= 0 ||
    !Number.isSafeInteger(computeExpiresAtMs) ||
    computeExpiresAtMs - authorizedAtMs !== policy.computeWindowSeconds * 1000 ||
    (retained.desiredState !== "running" && window.state !== "closed")
  ) {
    throw new Error("Crabbox retained compute window does not match acquisition policy");
  }
  let operation: WorkerRetentionObservation["operation"];
  if (retained.operation !== undefined) {
    const op = retained.operation;
    if (
      !isRecord(op) ||
      !boundedText(op.id, 128) ||
      (op.action !== "pause" && op.action !== "resume") ||
      (op.phase !== "pending" && op.phase !== "observed") ||
      !boundedText(op.expectedClaimRevision)
    ) {
      throw new Error("Crabbox retained lifecycle operation is invalid");
    }
    operation = {
      id: op.id,
      action: op.action,
      phase: op.phase,
      expectedClaimRevision: op.expectedClaimRevision,
    };
    assertCrabboxRetentionOperation(operation);
  }
  const now = Date.now();
  let state: WorkerRetentionObservation["state"] = "unavailable";
  if (retained.policyVerified) {
    if (value.state === "transitioning" || operation?.phase === "pending") {
      state = "transitioning";
    } else if (
      value.state === "suspended" &&
      ["Stopped", "Suspended", "Idle"].includes(retained.observedState)
    ) {
      state = "suspended";
    } else if (
      value.state === "compute-expired" ||
      (value.state === "running" && window.state === "active" && computeExpiresAtMs <= now)
    ) {
      state = "expired";
    } else if (
      value.state === "running" &&
      retained.observedState === "Running" &&
      value.ready === true &&
      retained.desiredState === "running" &&
      window.state === "active" &&
      authorizedAtMs <= now &&
      !retained.stopPending
    ) {
      state = "running";
    }
  }
  return {
    claimRevision: retained.claimRevision,
    state,
    computeExpiresAtMs,
    ...(operation ? { operation } : {}),
  };
}
