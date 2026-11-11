import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "typebox";

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

type RuntimeSnapshot = ReturnType<OpenClawPluginApi["runtime"]["config"]["current"]>;
type ModelProviderConfig = NonNullable<NonNullable<RuntimeSnapshot["models"]>["providers"]>[string];
export type RuntimeConfig = {
  apiKey?: string;
  baseUrl?: string;
  providerConfig?: ModelProviderConfig;
  credentialsUnavailable?: boolean;
  timeoutMs: number;
};
export const HOSTED_ORIGIN = "https://api.typesafe.ai";

/** Model providers configure the API root; origin-only System One URLs imply /v1. */
export function providerBaseUrl(value: string | undefined): string {
  const parsed = value ? URL.parse(value) : null;
  if (
    !parsed ||
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(
      "Invalid models.providers.typesafe.baseUrl; use an HTTP(S) API base URL without credentials, query, or fragment.",
    );
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/v1";
  return parsed.toString().replace(/\/+$/, "");
}

export function usesHostedEndpoint(config: Pick<RuntimeConfig, "baseUrl">): boolean {
  return !config.baseUrl || new URL(config.baseUrl).origin === HOSTED_ORIGIN;
}

export function hasCredentials(config: RuntimeConfig): boolean {
  return !config.credentialsUnavailable && Boolean(config.baseUrl || config.apiKey);
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
