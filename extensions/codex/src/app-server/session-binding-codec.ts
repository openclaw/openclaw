import { createHash } from "node:crypto";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  normalizeCodexAppServerBindingModelProvider,
  type CodexAppServerAuthProfileLookup,
} from "./auth-profile.js";
import {
  readCodexAppServerThreadBinding,
  readCodexBindingTimestamp,
  readPluginAppPolicyContext,
  readStoredCodexAppServerBinding,
  stripUndefinedBinding,
  type StoredCodexAppServerBinding,
} from "./session-binding-record.js";

const BOUNDED_BINDING_FINGERPRINT_PATTERN = /^sha256:[a-f0-9]{64}$/i;

export function hashCodexAppServerBindingFingerprint(canonical: string): string {
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

function normalizeLegacyBindingFingerprint(value: unknown): unknown {
  if (
    typeof value !== "string" ||
    value === "" ||
    value === "[]" ||
    BOUNDED_BINDING_FINGERPRINT_PATTERN.test(value)
  ) {
    return value;
  }
  return hashCodexAppServerBindingFingerprint(value);
}

function normalizeLegacyBindingFingerprints<
  T extends {
    dynamicToolsFingerprint?: unknown;
    userMcpServersFingerprint?: unknown;
  },
>(record: T): T {
  // Shipped sidecars can contain unbounded canonical JSON fingerprints. Bound
  // them at the legacy encoder so plugin-state registration cannot reject the row.
  let normalized = record;
  for (const key of ["dynamicToolsFingerprint", "userMcpServersFingerprint"] as const) {
    const value = record[key];
    const next = normalizeLegacyBindingFingerprint(value);
    if (next === value) {
      continue;
    }
    if (normalized === record) {
      normalized = { ...record };
    }
    Object.assign(normalized, { [key]: next });
  }
  return normalized;
}

export function normalizeStoredCodexAppServerBindingFingerprints(
  value: unknown,
): StoredCodexAppServerBinding | undefined {
  const stored = readStoredCodexAppServerBinding(value);
  if (!stored || stored.state !== "active") {
    return stored;
  }
  const binding = normalizeLegacyBindingFingerprints(stored.binding);
  return binding === stored.binding
    ? stored
    : readStoredCodexAppServerBinding({ ...stored, binding });
}

/** Encodes a migrated sidecar binding as one canonical plugin-state row. */
export function createStoredCodexAppServerBinding(
  value: unknown,
  options: {
    now?: string;
    lookup?: Omit<CodexAppServerAuthProfileLookup, "authProfileId">;
  } = {},
): Extract<StoredCodexAppServerBinding, { state: "active" }> | undefined {
  const rawRecord = asOptionalRecord(value);
  if (!rawRecord) {
    return undefined;
  }
  const record = normalizeLegacyBindingFingerprints(rawRecord);
  if (record.schemaVersion !== 1 && record.schemaVersion !== 2) {
    return undefined;
  }
  const pluginAppPolicyContext = readPluginAppPolicyContext(
    record.pluginAppPolicyContext,
    record.schemaVersion,
  );
  const historyCoveredThrough =
    readCodexBindingTimestamp(record.historyCoveredThrough) ??
    readCodexBindingTimestamp(record.updatedAt) ??
    readCodexBindingTimestamp(record.createdAt) ??
    readCodexBindingTimestamp(options.now) ??
    new Date().toISOString();
  const authProfileId = typeof record.authProfileId === "string" ? record.authProfileId : undefined;
  const binding = readCodexAppServerThreadBinding({
    ...record,
    modelProvider: normalizeCodexAppServerBindingModelProvider({
      ...options.lookup,
      authProfileId,
      modelProvider: typeof record.modelProvider === "string" ? record.modelProvider : undefined,
    }),
    cwd: typeof record.cwd === "string" ? record.cwd : "",
    pluginAppPolicyContext,
    historyCoveredThrough,
  });
  return binding
    ? {
        version: 1,
        state: "active",
        binding: stripUndefinedBinding(binding),
      }
    : undefined;
}
