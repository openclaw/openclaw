function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSecretRef(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const source = value.source;
  if (source !== "env" && source !== "file" && source !== "exec") {
    return false;
  }
  return (
    typeof value.provider === "string" &&
    value.provider.trim().length > 0 &&
    typeof value.id === "string" &&
    value.id.trim().length > 0
  );
}

export function normalizeSecretInputString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function hasConfiguredSecretInput(value: unknown): boolean {
  return normalizeSecretInputString(value) !== undefined || isSecretRef(value);
}

export function buildSecretInputSchema(zod: typeof import("zod")) {
  return zod.union([
    zod.string(),
    zod.object({
      source: zod.enum(["env", "file", "exec"]),
      provider: zod.string().min(1),
      id: zod.string().min(1),
    }),
  ]);
}
