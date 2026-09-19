import { Type } from "typebox";

const DEFAULT_MODEL = "jev-latest";
export const ConfigSchema = Type.Object(
  {
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
        default: DEFAULT_MODEL,
      }),
    ),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: 60000, default: 10000 })),
  },
  { additionalProperties: false },
);

export type RuntimeConfig = { apiKey?: string; model: string; timeoutMs: number };

/** Validate runtime settings and recognize materialized credentials without resolving inputs. */
export function runtimeConfig(config: Record<string, unknown> | undefined): RuntimeConfig {
  const key = config?.apiKey;
  const model = config?.model ?? DEFAULT_MODEL;
  const timeoutMs = config?.timeoutMs ?? 10000;
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
  return { apiKey: typeof key === "string" && key.trim() ? key : undefined, model, timeoutMs };
}
