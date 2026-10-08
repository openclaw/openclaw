import type { DecisionProviderV1 } from "openclaw/plugin-sdk/decisions";
import { Type } from "typebox";

export type DecisionProviderConfig = NonNullable<
  ReturnType<
    Parameters<NonNullable<DecisionProviderV1["createConfiguredProvider"]>>[0]["getConfig"]
  >
>;

const LOCAL_BASE_URL_PATTERN =
  "^https?://(?:localhost|127\\.0\\.0\\.1|\\[::1\\])(?::[0-9]{1,5})?/?$";
const localBaseUrlPattern = new RegExp(LOCAL_BASE_URL_PATTERN);
export const ConfigSchema = Type.Object(
  {
    baseUrl: Type.Optional(Type.String({ maxLength: 128, pattern: LOCAL_BASE_URL_PATTERN })),
    apiKey: Type.Optional(
      Type.Object(
        {
          source: Type.Union([
            Type.Literal("env"),
            Type.Literal("store"),
            Type.Literal("file"),
            Type.Literal("exec"),
          ]),
          provider: Type.String({ minLength: 1, maxLength: 128 }),
          id: Type.String({ minLength: 1, maxLength: 1024 }),
        },
        { additionalProperties: false },
      ),
    ),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: 60000, default: 30000 })),
  },
  { additionalProperties: false },
);

export type RuntimeConfig = {
  apiKey?: string;
  baseUrl?: string;
  timeoutMs: number;
  /** Model-provider declarations use the native hosted schema, even on loopback. */
  endpointMode?: "configured";
  headers?: Record<string, string>;
  authHeader?: boolean;
};

/** Configured model endpoints are API prefixes; HTTP is reserved for explicit loopback. */
export function configuredBaseUrl(value: string): string {
  const parsed = value === value.trim() ? URL.parse(value) : null;
  const loopback = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?(?:\/|$)/.test(
    value,
  );
  if (
    !parsed ||
    (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) ||
    parsed.username ||
    parsed.password ||
    value.includes("?") ||
    value.includes("#") ||
    (["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) && !loopback)
  ) {
    throw new Error(
      "Invalid TypeSafe model-provider baseUrl; use HTTPS or an HTTP loopback API prefix.",
    );
  }
  return parsed.toString().replace(/\/+$/, "");
}

/** The host owns secret preparation; unresolved inputs cannot make an endpoint ready. */
export function configuredRuntimeConfig(
  config: DecisionProviderConfig | undefined,
): RuntimeConfig | undefined {
  if (!config || (config.apiKey !== undefined && typeof config.apiKey !== "string")) {
    return undefined;
  }
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(config.headers ?? {})) {
    if (typeof value !== "string") {
      return undefined;
    }
    headers[name] = value;
  }
  const timeoutSeconds = config.timeoutSeconds ?? 30;
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    return undefined;
  }
  try {
    return {
      baseUrl: configuredBaseUrl(config.baseUrl),
      apiKey: config.apiKey?.trim() ? config.apiKey : undefined,
      headers,
      authHeader: config.authHeader,
      timeoutMs: timeoutSeconds * 1000,
      endpointMode: "configured",
    };
  } catch {
    return undefined;
  }
}

/** A configured endpoint grants access to one loopback origin, never arbitrary private hosts. */
export function localBaseUrl(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed =
    typeof value === "string" && value === value.trim() && localBaseUrlPattern.test(value)
      ? URL.parse(value)
      : null;
  if (!parsed) {
    throw new Error(
      "Invalid TypeSafe baseUrl; use an http(s) loopback origin without a path, credentials, query, or fragment.",
    );
  }
  return parsed.origin;
}

/** Validate runtime settings and recognize materialized credentials without resolving inputs. */
export function runtimeConfig(config: Record<string, unknown> | undefined): RuntimeConfig {
  const baseUrl = localBaseUrl(config?.baseUrl);
  const timeoutMs = config?.timeoutMs ?? 30000;
  if (
    typeof timeoutMs !== "number" ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1000 ||
    timeoutMs > 60000
  ) {
    throw new Error("Invalid TypeSafe configuration; check plugin Settings.");
  }
  if (baseUrl) {
    return { baseUrl, timeoutMs };
  }
  const key = config?.apiKey;
  return { apiKey: typeof key === "string" && key.trim() ? key : undefined, timeoutMs };
}
