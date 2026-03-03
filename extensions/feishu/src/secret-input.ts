import * as pluginSdk from "openclaw/plugin-sdk";
import { z } from "zod";

type SecretRefLike = {
  source: "env" | "file" | "exec";
  provider: string;
  id: string;
};

function fallbackNormalizeSecretInputString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function coerceSecretRefLike(value: unknown): SecretRefLike | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const source = candidate.source;
  const provider = candidate.provider;
  const id = candidate.id;
  if (
    (source === "env" || source === "file" || source === "exec") &&
    typeof provider === "string" &&
    provider.trim().length > 0 &&
    typeof id === "string" &&
    id.trim().length > 0
  ) {
    return {
      source,
      provider,
      id,
    };
  }
  return null;
}

function fallbackHasConfiguredSecretInput(value: unknown): boolean {
  if (fallbackNormalizeSecretInputString(value)) {
    return true;
  }
  return coerceSecretRefLike(value) !== null;
}

function fallbackNormalizeResolvedSecretInputString(params: {
  value: unknown;
  path: string;
}): string | undefined {
  const normalized = fallbackNormalizeSecretInputString(params.value);
  if (normalized) {
    return normalized;
  }
  const ref = coerceSecretRefLike(params.value);
  if (!ref) {
    return undefined;
  }
  throw new Error(
    `${params.path}: unresolved SecretRef "${ref.source}:${ref.provider}:${ref.id}". Resolve this command against an active gateway runtime snapshot before reading it.`,
  );
}

const sdk = pluginSdk as Partial<typeof pluginSdk>;

export const normalizeSecretInputString =
  typeof sdk.normalizeSecretInputString === "function"
    ? sdk.normalizeSecretInputString
    : fallbackNormalizeSecretInputString;

export const hasConfiguredSecretInput =
  typeof sdk.hasConfiguredSecretInput === "function"
    ? sdk.hasConfiguredSecretInput
    : fallbackHasConfiguredSecretInput;

export const normalizeResolvedSecretInputString =
  typeof sdk.normalizeResolvedSecretInputString === "function"
    ? sdk.normalizeResolvedSecretInputString
    : fallbackNormalizeResolvedSecretInputString;

export function buildSecretInputSchema() {
  return z.union([
    z.string(),
    z.object({
      source: z.enum(["env", "file", "exec"]),
      provider: z.string().min(1),
      id: z.string().min(1),
    }),
  ]);
}
