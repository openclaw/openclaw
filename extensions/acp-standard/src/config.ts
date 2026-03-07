import type { OpenClawPluginConfigSchema } from "openclaw/plugin-sdk";

export type StandardAcpPluginConfig = {
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
};

export type ResolvedStandardAcpConfig = {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(path: string[], message: string) {
  return { success: false as const, error: { issues: [{ path, message }] } };
}

export function createStandardAcpConfigSchema(): OpenClawPluginConfigSchema {
  return {
    safeParse(value: unknown) {
      if (value === undefined) return { success: true, data: undefined };
      if (!isRecord(value)) return fail([], "expected config object");
      if (value.command !== undefined && typeof value.command !== "string")
        return fail(["command"], "must be a string");
      if (
        value.args !== undefined &&
        (!Array.isArray(value.args) || !value.args.every((a: unknown) => typeof a === "string"))
      )
        return fail(["args"], "must be an array of strings");
      if (value.cwd !== undefined && typeof value.cwd !== "string")
        return fail(["cwd"], "must be a string");
      if (
        value.env !== undefined &&
        (!isRecord(value.env) || !Object.values(value.env).every((v) => typeof v === "string"))
      )
        return fail(["env"], "must be an object with string values");
      return { success: true, data: value };
    },
    jsonSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        command: { type: "string" },
        args: { type: "array", items: { type: "string" } },
        cwd: { type: "string" },
        env: { type: "object", additionalProperties: { type: "string" } },
      },
    },
  };
}

export function resolveStandardAcpConfig(params: {
  rawConfig: unknown;
  workspaceDir?: string;
}): ResolvedStandardAcpConfig {
  const raw = (params.rawConfig ?? {}) as StandardAcpPluginConfig;
  return {
    command: raw.command ?? "kiro-cli",
    args: raw.args ?? ["acp"],
    cwd: raw.cwd ?? params.workspaceDir ?? process.cwd(),
    env: raw.env ?? {},
  };
}
