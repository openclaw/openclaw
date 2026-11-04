// Hermes environment interpolation shared by provider and MCP config.
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

const MCP_ENV_REFERENCE_RE = /\$\{([^}]+)\}/gu;

type ResolvedEnvValue<T> = { unresolved: boolean; referenced: boolean; value: T };

export function normalizeHermesEnvReferenceName(value: string): string | undefined {
  const trimmed = value.trim();
  const name = trimmed.startsWith("env:") ? trimmed.slice("env:".length).trim() : trimmed;
  return name || undefined;
}

export function resolveMcpEnvReferences(
  value: string,
  env: Record<string, string>,
): ResolvedEnvValue<string>;
export function resolveMcpEnvReferences(
  value: unknown,
  env: Record<string, string>,
): ResolvedEnvValue<unknown>;
export function resolveMcpEnvReferences(
  value: unknown,
  env: Record<string, string>,
): ResolvedEnvValue<unknown> {
  let unresolved = false;
  let referenced = false;
  function resolve(entry: unknown): unknown {
    if (typeof entry === "string") {
      return entry.replace(MCP_ENV_REFERENCE_RE, (match, rawName: string) => {
        referenced = true;
        const name = normalizeHermesEnvReferenceName(rawName);
        const replacement = name ? env[name] : undefined;
        if (replacement === undefined) {
          unresolved = true;
          return match;
        }
        return replacement;
      });
    }
    if (Array.isArray(entry)) {
      return entry.map(resolve);
    }
    if (isRecord(entry)) {
      return Object.fromEntries(
        Object.entries(entry).map(([key, childValue]) => [key, resolve(childValue)]),
      );
    }
    return entry;
  }
  const resolved = resolve(value);
  return { unresolved, referenced, value: resolved };
}
