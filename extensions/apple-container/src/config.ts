import type { OpenClawPluginConfigSchema } from "openclaw/plugin-sdk/core";

export type AppleContainerPluginConfig = {
  command?: string;
  timeoutSeconds?: number;
};

export type ResolvedAppleContainerPluginConfig = {
  command: string;
  timeoutMs: number;
};

const DEFAULT_COMMAND = "container";
const DEFAULT_TIMEOUT_MS = 30_000;

type ParseSuccess = { success: true; data?: AppleContainerPluginConfig };
type ParseFailure = {
  success: false;
  error: {
    issues: Array<{ path: Array<string | number>; message: string }>;
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function trimString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function createAppleContainerPluginConfigSchema(): OpenClawPluginConfigSchema {
  const safeParse = (value: unknown): ParseSuccess | ParseFailure => {
    if (value === undefined) {
      return { success: true, data: undefined };
    }
    if (!isRecord(value)) {
      return {
        success: false,
        error: { issues: [{ path: [], message: "expected config object" }] },
      };
    }
    const allowedKeys = new Set(["command", "timeoutSeconds"]);
    for (const key of Object.keys(value)) {
      if (!allowedKeys.has(key)) {
        return {
          success: false,
          error: { issues: [{ path: [key], message: `unknown config key: ${key}` }] },
        };
      }
    }

    if (
      value.timeoutSeconds !== undefined &&
      (typeof value.timeoutSeconds !== "number" ||
        !Number.isFinite(value.timeoutSeconds) ||
        value.timeoutSeconds < 1)
    ) {
      return {
        success: false,
        error: {
          issues: [{ path: ["timeoutSeconds"], message: "timeoutSeconds must be a number >= 1" }],
        },
      };
    }

    return {
      success: true,
      data: {
        command: trimString(value.command),
        timeoutSeconds: value.timeoutSeconds as number | undefined,
      },
    };
  };

  return {
    safeParse,
    jsonSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        command: { type: "string" },
        timeoutSeconds: { type: "number", minimum: 1 },
      },
    },
  };
}

export function resolveAppleContainerPluginConfig(
  value: unknown,
): ResolvedAppleContainerPluginConfig {
  const parsed = createAppleContainerPluginConfigSchema().safeParse?.(value);
  if (!parsed || !parsed.success) {
    const issues = parsed && !parsed.success ? parsed.error?.issues : undefined;
    const message =
      issues?.map((issue: { message: string }) => issue.message).join(", ") || "invalid config";
    throw new Error(`Invalid apple-container plugin config: ${message}`);
  }
  const raw = parsed.data ?? {};
  return {
    command: raw.command ?? DEFAULT_COMMAND,
    timeoutMs:
      typeof raw.timeoutSeconds === "number"
        ? Math.floor(raw.timeoutSeconds * 1000)
        : DEFAULT_TIMEOUT_MS,
  };
}
