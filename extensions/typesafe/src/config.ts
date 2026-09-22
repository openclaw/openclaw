import { Type } from "typebox";

const DEFAULT_MODEL = "jev-latest";
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
    model: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 128,
        pattern: "^[a-zA-Z0-9._/-]+$",
        description: "Tool default: jev-latest for hosted Jev, kev-latest for a local endpoint.",
      }),
    ),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: 60000, default: 30000 })),
  },
  { additionalProperties: false },
);

export type RuntimeConfig = { apiKey?: string; baseUrl?: string; model: string; timeoutMs: number };

/** A configured endpoint grants access to one loopback origin, never arbitrary private hosts. */
export function localBaseUrl(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  try {
    if (typeof value !== "string" || value !== value.trim() || !localBaseUrlPattern.test(value)) {
      throw new Error();
    }
    return new URL(value).origin;
  } catch {
    throw new Error(
      "Invalid TypeSafe baseUrl; use an http(s) loopback origin without a path, credentials, query, or fragment.",
    );
  }
}

/** Validate runtime settings and recognize materialized credentials without resolving inputs. */
export function runtimeConfig(config: Record<string, unknown> | undefined): RuntimeConfig {
  const baseUrl = localBaseUrl(config?.baseUrl);
  const model = config?.model ?? (baseUrl ? "kev-latest" : DEFAULT_MODEL);
  const timeoutMs = config?.timeoutMs ?? 30000;
  if (
    typeof model !== "string" ||
    !/^[a-zA-Z0-9._/-]{1,128}$/.test(model) ||
    typeof timeoutMs !== "number" ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1000 ||
    timeoutMs > 60000
  ) {
    throw new Error("Invalid TypeSafe configuration; check plugin Settings.");
  }
  if (baseUrl) {
    return { baseUrl, model, timeoutMs };
  }
  const key = config?.apiKey;
  return { apiKey: typeof key === "string" && key.trim() ? key : undefined, model, timeoutMs };
}
