import { redactSensitiveText } from "openclaw/plugin-sdk/logging-core";
import {
  isRecord,
  normalizeOptionalString as nonEmptyString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { parseCrabboxJson, sanitizeCrabboxNotice } from "./crabbox-worker-command.js";
import { parseCrabboxDurationMs } from "./crabbox-worker-profile.js";
import { readCrabboxResourceReceipt } from "./crabbox-worker-resource-receipt.js";

export type CrabboxLeaseLifetime = {
  expiresAtMs?: number;
  idleTimeoutMs?: number;
  maxLifetimeMs?: number;
  runtimeExtension?: boolean;
  extension?: string;
  createdAtMs?: number;
  ttlMs?: number;
  policyNotice?: string;
};

function timestamp(value: unknown): number | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  const parsed = /^\d+$/u.test(value) ? Number(value) * 1000 : Date.parse(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function parseCrabboxLeaseLifetime(value: Record<string, unknown>): CrabboxLeaseLifetime {
  const policy = isRecord(value.leasePolicy) ? value.leasePolicy : {};
  const labels = isRecord(value.labels) ? value.labels : {};
  const positiveSeconds = (input: unknown) => {
    const seconds = typeof input === "string" ? Number(input) : input;
    return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0
      ? seconds * 1000
      : undefined;
  };
  const fields: CrabboxLeaseLifetime = {
    expiresAtMs: timestamp(value.expiresAt),
    idleTimeoutMs:
      parseCrabboxDurationMs(value.idleTimeout) ?? positiveSeconds(value.idleTimeoutSeconds),
    maxLifetimeMs:
      parseCrabboxDurationMs(value.maxLifetime) ?? positiveSeconds(policy.maxTTLSeconds),
    runtimeExtension:
      typeof policy.runtimeExtension === "boolean" ? policy.runtimeExtension : undefined,
    extension: nonEmptyString(policy.extension),
    createdAtMs: timestamp(value.createdAt) ?? timestamp(labels.created_at),
    ttlMs: positiveSeconds(value.ttlSeconds) ?? positiveSeconds(labels.ttl_secs),
    policyNotice:
      typeof value.policyNotice === "string"
        ? sanitizeCrabboxNotice(value.policyNotice)
        : undefined,
  };
  return Object.fromEntries(Object.entries(fields).filter(([, field]) => field !== undefined));
}

export type ParsedInspect = ReturnType<typeof parseInspectJson>;

export function parseInspectJson(stdout: string) {
  const value = parseCrabboxJson(stdout, "inspect");
  if (!isRecord(value)) {
    throw new Error("Crabbox inspect returned invalid JSON");
  }

  const id = nonEmptyString(value.id);
  const state = nonEmptyString(value.state)?.toLowerCase();
  if (!id || !/^\S{1,128}$/u.test(id) || !state) {
    throw new Error("Crabbox inspect returned an invalid lease identity or state");
  }
  if (value.ready !== undefined && typeof value.ready !== "boolean") {
    throw new Error("Crabbox inspect returned an invalid ready state");
  }
  if (value.sshUser !== undefined && typeof value.sshUser !== "string") {
    throw new Error("Crabbox inspect returned an invalid SSH user");
  }
  const sshUser = nonEmptyString(value.sshUser);
  if (value.tailscale !== undefined && !isRecord(value.tailscale)) {
    throw new Error("Crabbox inspect returned invalid Tailscale state");
  }
  const tailscaleEnabled = value.tailscale !== undefined;
  let awsInstanceProfileAttached: boolean | undefined;
  if (value.providerMetadata !== undefined) {
    if (!isRecord(value.providerMetadata)) {
      throw new Error("Crabbox inspect returned invalid provider metadata");
    }
    const attached = value.providerMetadata.instanceProfileAttached;
    if (attached !== undefined && typeof attached !== "boolean") {
      throw new Error("Crabbox inspect returned invalid AWS instance profile metadata");
    }
    awsInstanceProfileAttached = attached;
  }

  const failureError = nonEmptyString(value.failureError);
  const lifetime = parseCrabboxLeaseLifetime(value);
  const resourceReceipt = readCrabboxResourceReceipt(value);
  return {
    id,
    state,
    tailscaleEnabled,
    ...(resourceReceipt ? { resourceReceipt } : {}),
    ...(Object.keys(lifetime).length ? { lifetime } : {}),
    ...(failureError
      ? {
          failureError: truncateUtf16Safe(
            redactSensitiveText(failureError).replace(/\s+/gu, " "),
            512,
          ),
        }
      : {}),
    ...(awsInstanceProfileAttached !== undefined ? { awsInstanceProfileAttached } : {}),
    ...(typeof value.ready === "boolean" ? { ready: value.ready } : {}),
    ...(sshUser && sshUser !== "<token>" ? { sshUser } : {}),
  };
}
