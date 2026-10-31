import { isDeepStrictEqual } from "node:util";
import type { WorkerResourceReceipt } from "openclaw/plugin-sdk/plugin-entry";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

/** Azure Sandbox status carries provider-observed identity labels, not local inventory guesses. */
export function readCrabboxResourceReceipt(
  value: Record<string, unknown>,
): WorkerResourceReceipt | undefined {
  if (value.provider !== "azure-sandbox") {
    return undefined;
  }
  if (value.retention !== undefined) {
    throw new Error(
      "Retained Crabbox allocations require the session-disk lifecycle; adoption refused",
    );
  }
  const labels = isRecord(value.labels) ? value.labels : {};
  const fields = {
    provider: value.provider,
    resourceId: value.serverId,
    slug: value.slug,
    attempt: labels.crabbox_attempt,
    fingerprint: labels.crabbox_fingerprint,
  };
  if (typeof value.id !== "string" || labels.crabbox_lease !== value.id) {
    return undefined;
  }
  const identity: Record<string, string> = {};
  for (const [key, field] of Object.entries(fields)) {
    if (
      typeof field !== "string" ||
      !field.trim() ||
      field !== field.trim() ||
      field.length > 2048 ||
      /\p{Cc}/u.test(field)
    ) {
      // Deleted/legacy observations need not carry labels; they cannot qualify a live resource.
      return undefined;
    }
    identity[key] = field;
  }
  return { version: 1, leaseId: value.id, identity };
}

export function assertCrabboxResourceReceipt(
  expected: WorkerResourceReceipt,
  observed: WorkerResourceReceipt | undefined,
): void {
  if (!observed || !isDeepStrictEqual(expected, observed)) {
    throw new Error("Crabbox resource identity is unavailable or changed; replacement refused");
  }
}

export function crabboxResourceIdentityArgs(receipt: WorkerResourceReceipt): string[] {
  if (
    receipt.version !== 1 ||
    receipt.identity.provider !== "azure-sandbox" ||
    !receipt.identity.resourceId ||
    !receipt.identity.slug
  ) {
    throw new Error("Crabbox resource receipt is unsupported");
  }
  return [
    "--expected-provider-lease-id",
    receipt.leaseId,
    "--expected-provider-attempt-lease-id",
    receipt.leaseId,
    "--expected-provider-slug",
    receipt.identity.slug,
    "--expected-provider-resource-id",
    receipt.identity.resourceId,
  ];
}
