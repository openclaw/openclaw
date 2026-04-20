import {
  isDangerousHostEnvOverrideVarName,
  isDangerousHostEnvVarName,
} from "../infra/host-env-security.js";

export function isMcpConfigRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toMcpFilteredStringRecord(
  value: unknown,
  options?: {
    onDroppedEntry?: (key: string, value: unknown) => void;
    shouldDropKey?: (key: string) => boolean;
  },
): Record<string, string> | undefined {
  if (!isMcpConfigRecord(value)) {
    return undefined;
  }
  const entries = Object.entries(value)
    .map(([key, entry]) => {
      if (options?.shouldDropKey?.(key)) {
        options?.onDroppedEntry?.(key, entry);
        return null;
      }
      if (typeof entry === "string") {
        return [key, entry] as const;
      }
      if (typeof entry === "number" || typeof entry === "boolean") {
        return [key, String(entry)] as const;
      }
      options?.onDroppedEntry?.(key, entry);
      return null;
    })
    .filter((entry): entry is readonly [string, string] => entry !== null);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export function toMcpStringRecord(
  value: unknown,
  options?: { onDroppedEntry?: (key: string, value: unknown) => void },
): Record<string, string> | undefined {
  return toMcpFilteredStringRecord(value, options);
}

export function toMcpEnvRecord(
  value: unknown,
  options?: { onDroppedEntry?: (key: string, value: unknown) => void },
): Record<string, string> | undefined {
  return toMcpFilteredStringRecord(value, {
    ...options,
    shouldDropKey: (key) =>
      isDangerousHostEnvVarName(key) || isDangerousHostEnvOverrideVarName(key),
  });
}

export function toMcpStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const entries = value.filter((entry): entry is string => typeof entry === "string");
  return entries.length > 0 ? entries : [];
}
