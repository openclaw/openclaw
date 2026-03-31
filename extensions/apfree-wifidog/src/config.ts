import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { OpenClawPluginConfigSchema } from "openclaw/plugin-sdk/plugin-entry";
import type { AwasConfig } from "./awas-proxy.js";

const DEFAULT_BIND = "127.0.0.1";
const DEFAULT_PATH = "/ws/wifidogx";
const DEFAULT_PORT = 8001;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_PAYLOAD_BYTES = 256 * 1024;

// AWAS (Auth WebSocket Server) defaults
const DEFAULT_AWAS_HOST = "127.0.0.1";
const DEFAULT_AWAS_PORT = 80;
const DEFAULT_AWAS_PATH = "/ws/wifidogx";

export const ApFreeWifidogConfigSchema = Type.Object(
  {
    enabled: Type.Optional(Type.Boolean()),
    bind: Type.Optional(Type.String({ minLength: 1 })),
    port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65_535 })),
    path: Type.Optional(Type.String({ minLength: 1 })),
    allowDeviceIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    requestTimeoutMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: 120_000 })),
    maxPayloadBytes: Type.Optional(Type.Integer({ minimum: 1024, maximum: 1_048_576 })),
    token: Type.Optional(
      Type.String({ minLength: 1, description: "Shared secret for device authentication." }),
    ),
    // AWAS auth server proxy configuration
    awasEnabled: Type.Optional(Type.Boolean()),
    awasHost: Type.Optional(Type.String({ minLength: 1 })),
    awasPort: Type.Optional(Type.Integer({ minimum: 1, maximum: 65_535 })),
    awasPath: Type.Optional(Type.String({ minLength: 1 })),
    awasSsl: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

type ApFreeWifidogConfigInput = Static<typeof ApFreeWifidogConfigSchema>;

export type ResolvedApFreeWifidogConfig = {
  enabled: boolean;
  bind: string;
  port: number;
  path: string;
  allowDeviceIds: string[];
  requestTimeoutMs: number;
  maxPayloadBytes: number;
  token?: string;
  awas: AwasConfig;
};

function normalizePath(input: string | undefined): string {
  const trimmed = input?.trim() || DEFAULT_PATH;
  if (trimmed.startsWith("/")) {
    return trimmed;
  }
  return `/${trimmed}`;
}

function uniqSorted(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))].toSorted();
}

function asConfigObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readIntegerInRange(value: unknown, minimum: number, maximum: number): number | undefined {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= minimum &&
    value <= maximum
    ? value
    : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.every((entry) => typeof entry === "string") ? uniqSorted(value) : undefined;
}

export function resolveApFreeWifidogConfig(input: unknown): ResolvedApFreeWifidogConfig {
  const parsed = Value.Check(ApFreeWifidogConfigSchema, input)
    ? (input as ApFreeWifidogConfigInput)
    : asConfigObject(input);

  return {
    // Keep bridge enabled by default when plugin is loaded unless explicitly disabled.
    enabled: readBoolean(parsed?.enabled) !== false,
    bind: readNonEmptyString(parsed?.bind) || DEFAULT_BIND,
    port: readIntegerInRange(parsed?.port, 1, 65_535) ?? DEFAULT_PORT,
    path: normalizePath(readNonEmptyString(parsed?.path)),
    allowDeviceIds: readStringArray(parsed?.allowDeviceIds) ?? [],
    requestTimeoutMs:
      readIntegerInRange(parsed?.requestTimeoutMs, 1000, 120_000) ?? DEFAULT_TIMEOUT_MS,
    maxPayloadBytes:
      readIntegerInRange(parsed?.maxPayloadBytes, 1024, 1_048_576) ?? DEFAULT_MAX_PAYLOAD_BYTES,
    token: readNonEmptyString(parsed?.token),
    awas: {
      enabled: readBoolean(parsed?.awasEnabled) === true,
      host: readNonEmptyString(parsed?.awasHost) || DEFAULT_AWAS_HOST,
      port: readIntegerInRange(parsed?.awasPort, 1, 65_535) ?? DEFAULT_AWAS_PORT,
      path: normalizePath(readNonEmptyString(parsed?.awasPath) ?? DEFAULT_AWAS_PATH),
      ssl: readBoolean(parsed?.awasSsl) === true,
    },
  };
}

export function createApFreeWifidogPluginConfigSchema(): OpenClawPluginConfigSchema {
  return {
    safeParse(value: unknown) {
      if (value === undefined) {
        return { success: true, data: resolveApFreeWifidogConfig(undefined) };
      }
      const issues = [...Value.Errors(ApFreeWifidogConfigSchema, value)];
      if (issues.length > 0) {
        return {
          success: false,
          error: {
            issues: issues.map((issue) => ({
              path: [],
              message: issue.message,
            })),
          },
        };
      }
      return { success: true, data: resolveApFreeWifidogConfig(value) };
    },
    jsonSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        enabled: { type: "boolean" },
        bind: { type: "string" },
        port: { type: "integer", minimum: 1, maximum: 65535 },
        path: { type: "string" },
        allowDeviceIds: {
          type: "array",
          items: { type: "string" },
        },
        requestTimeoutMs: {
          type: "integer",
          minimum: 1000,
          maximum: 120000,
        },
        maxPayloadBytes: {
          type: "integer",
          minimum: 1024,
          maximum: 1048576,
        },
        token: { type: "string" },
        awasEnabled: { type: "boolean" },
        awasHost: { type: "string" },
        awasPort: { type: "integer", minimum: 1, maximum: 65535 },
        awasPath: { type: "string" },
        awasSsl: { type: "boolean" },
      },
    },
  };
}
