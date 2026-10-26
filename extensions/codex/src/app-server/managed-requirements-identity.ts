import { createHash } from "node:crypto";
import { fingerprintCodexPolicy } from "./config-policy-json.js";
import { isJsonObject, type JsonObject } from "./protocol.js";
import { fingerprintJsonObject } from "./thread-fingerprints.js";

const SEMANTIC_PREFIX = "codex-managed-requirements:v2:";
const NEW_NULLABLE_REQUIREMENTS = ["modelProvider", "modelProviders", "application"] as const;
const NEW_BROWSER_REQUIREMENTS = ["extension", "allowWebmcp"] as const;

export type CodexManagedRequirementsIdentity = {
  // Keep the original representation for Gateway rollback readers.
  managedRequirementsFingerprint: string;
  managedRequirementsSemanticFingerprint: string;
};

export function isCodexManagedRequirementsSemanticFingerprint(value: unknown): value is string {
  return typeof value === "string" && /^codex-managed-requirements:v2:[a-f0-9]{64}$/.test(value);
}

function legacyFingerprint(requirements: JsonObject | null): string {
  // Preserve JSON.stringify's integer-key ordering, including nested policies.
  return createHash("sha256")
    .update(fingerprintJsonObject({ version: 1, requirements }))
    .digest("hex");
}

/** Normalize only reviewed protocol defaults; retain every unknown field and value. */
function semanticRequirements(requirements: JsonObject | null): JsonObject | null {
  if (requirements === null) {
    return null;
  }
  const normalized = { ...requirements };
  // Codex ConfigRequirements: None means no constraint. The retired Windows
  // private-desktop field is equivalent to absence only when it was null.
  for (const key of [...NEW_NULLABLE_REQUIREMENTS, "windowsSandboxPrivateDesktop"]) {
    if (normalized[key] === null) {
      delete normalized[key];
    }
  }
  // config_processor::map_requirements_to_api reports both methods when login
  // is unrestricted. A subset, an empty list, null, or a future method is not equivalent.
  const methods = normalized.allowedLoginMethods;
  if (
    Array.isArray(methods) &&
    methods.length === 2 &&
    methods.includes("api") &&
    methods.includes("chatgpt")
  ) {
    delete normalized.allowedLoginMethods;
  }
  if (isJsonObject(normalized.browserUse)) {
    const browser = { ...normalized.browserUse };
    for (const key of NEW_BROWSER_REQUIREMENTS) {
      if (browser[key] === null) {
        delete browser[key];
      }
    }
    normalized.browserUse = browser;
  }
  return normalized;
}

export function buildCodexManagedRequirementsIdentity(
  requirements: JsonObject | null,
): CodexManagedRequirementsIdentity {
  return {
    managedRequirementsFingerprint: legacyFingerprint(requirements),
    managedRequirementsSemanticFingerprint:
      SEMANTIC_PREFIX +
      fingerprintCodexPolicy({ version: 2, requirements: semanticRequirements(requirements) }),
  };
}

/** Validate saved grants without rewriting them or capturing new owner authority. */
export function matchesCodexManagedRequirementsFingerprint(
  requirements: JsonObject | null,
  allowed: string,
): boolean {
  const identity = buildCodexManagedRequirementsIdentity(requirements);
  if (isCodexManagedRequirementsSemanticFingerprint(allowed)) {
    return allowed === identity.managedRequirementsSemanticFingerprint;
  }
  if (!/^[a-f0-9]{64}$/.test(allowed)) {
    return false;
  }
  if (allowed === identity.managedRequirementsFingerprint) {
    return true;
  }
  const normalized = semanticRequirements(requirements);
  if (normalized === null) {
    return false;
  }

  // Legacy grants contain only a hash, not a policy snapshot. Reconstruct only
  // the two shipped representations; never drop an unknown or non-default requirement.
  const browser = normalized.browserUse;
  if (
    [...NEW_NULLABLE_REQUIREMENTS, "allowedLoginMethods"].every(
      (key) => !Object.hasOwn(normalized, key),
    ) &&
    (!isJsonObject(browser) ||
      NEW_BROWSER_REQUIREMENTS.every((key) => !Object.hasOwn(browser, key)))
  ) {
    const legacy153 = {
      ...normalized,
      windowsSandboxPrivateDesktop: normalized.windowsSandboxPrivateDesktop ?? null,
    };
    if (allowed === legacyFingerprint(legacy153)) {
      return true;
    }
  }
  if (!Object.hasOwn(normalized, "windowsSandboxPrivateDesktop")) {
    const legacy163: JsonObject = {
      modelProvider: null,
      modelProviders: null,
      application: null,
      allowedLoginMethods: ["api", "chatgpt"],
      ...normalized,
      ...(isJsonObject(browser)
        ? { browserUse: { extension: null, allowWebmcp: null, ...browser } }
        : {}),
    };
    return allowed === legacyFingerprint(legacy163);
  }
  return false;
}
