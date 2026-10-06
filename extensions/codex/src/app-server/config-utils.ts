import { createHmac, randomBytes } from "node:crypto";
import { resolveGlobalSingleton } from "openclaw/plugin-sdk/global-singleton";
import { splitCommandArgs } from "openclaw/plugin-sdk/process-runtime";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import {
  asOptionalRecord as readRecord,
  normalizeOptionalString as readNonEmptyString,
  normalizeTrimmedStringList,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import type { OpenClawExecAsk, OpenClawExecSecurity } from "./config-contracts.shared.js";
import { normalizeCodexServiceTier } from "./service-tier-normalization.js";

export { normalizeCodexServiceTier } from "./service-tier-normalization.js";

const START_OPTIONS_KEY_SECRET = resolveGlobalSingleton(
  Symbol.for("openclaw.codexAppServerStartOptionsKeySecret"),
  () => randomBytes(32),
);
const PLAIN_DECIMAL_NUMBER_RE = /^[+-]?(?:(?:\d+\.?\d*)|(?:\.\d+))$/;

export { readNonEmptyString, readRecord };

export function isCodexFastServiceTier(value: unknown): boolean {
  return normalizeCodexServiceTier(value) === "priority";
}

export function normalizeHeaders(
  value: Record<string, unknown> | undefined,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(value ?? {})
      .map(
        ([key, child]) =>
          [
            key.trim(),
            normalizeResolvedSecretInputString({
              value: child,
              path: `plugins.entries.codex.config.appServer.headers.${key}`,
            }),
          ] as const,
      )
      .filter((entry): entry is readonly [string, string] => Boolean(entry[0] && entry[1])),
  );
}

export function readExecSecurity(value: unknown): OpenClawExecSecurity | undefined {
  return value === "deny" || value === "allowlist" || value === "full" ? value : undefined;
}

export function readExecAsk(value: unknown): OpenClawExecAsk | undefined {
  return value === "off" || value === "on-miss" || value === "always" ? value : undefined;
}

export function readNumberEnv(value: string | undefined): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed || !PLAIN_DECIMAL_NUMBER_RE.test(trimmed)) {
    return undefined;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function resolveArgs(
  configArgs: string | string[] | undefined,
  envArgs: string | undefined,
): string[] {
  if (Array.isArray(configArgs)) {
    return normalizeTrimmedStringList(configArgs);
  }
  // v2026.9.1 string overrides preserve backslashes and accept unfinished quotes;
  // applying shell escaping or strict quote validation would change existing argv.
  return splitCommandArgs(configArgs ?? envArgs ?? "", {
    allowUnclosedQuotes: true,
  });
}

export function hashSecretForKey(value: string | undefined, label: string): string | null {
  if (!value) {
    return null;
  }
  return createHmac("sha256", START_OPTIONS_KEY_SECRET)
    .update(label)
    .update("\0")
    .update(value)
    .digest("hex");
}
