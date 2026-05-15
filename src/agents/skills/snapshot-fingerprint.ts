import crypto from "node:crypto";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { stableStringify } from "../stable-stringify.js";

function isSensitiveConfigKey(key: string): boolean {
  const normalized = key.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
  return (
    normalized.endsWith("apikey") ||
    normalized.endsWith("token") ||
    normalized.endsWith("secret") ||
    normalized.endsWith("password") ||
    normalized.endsWith("privatekey") ||
    normalized.endsWith("clientsecret")
  );
}

function redactSensitiveConfigValue(value: unknown): unknown {
  if (value === undefined || value === null || value === false || value === "") {
    return value;
  }
  if (typeof value === "string") {
    return value.trim() ? "[redacted:string]" : "";
  }
  if (typeof value === "number") {
    return Number.isFinite(value) && value !== 0 ? "[redacted:number]" : value;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.length === 0 ? [] : "[redacted:array]";
  }
  return "[redacted:object]";
}

function redactConfigForSkillSnapshot(value: unknown, stack = new WeakSet<object>()): unknown {
  if (!value || typeof value !== "object") {
    return value;
  }
  if (stack.has(value)) {
    return "[Circular]";
  }
  stack.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry) => redactConfigForSkillSnapshot(entry, stack));
    }
    const redacted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).toSorted()) {
      const field = (value as Record<string, unknown>)[key];
      redacted[key] = isSensitiveConfigKey(key)
        ? redactSensitiveConfigValue(field)
        : redactConfigForSkillSnapshot(field, stack);
    }
    return redacted;
  } finally {
    stack.delete(value);
  }
}

// Skill frontmatter `requires.config`, configured skill env, filters, and
// skills.load.extraDirs all read the OpenClaw config. Persisting a redacted
// fingerprint with the session snapshot makes config-driven skill exposure
// changes deterministic across gateway restarts without storing secrets.
export function fingerprintSkillSnapshotConfig(config?: OpenClawConfig): string {
  return crypto
    .createHash("sha256")
    .update(stableStringify(redactConfigForSkillSnapshot(config ?? {})))
    .digest("hex");
}
