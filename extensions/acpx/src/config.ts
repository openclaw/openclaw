import path from "node:path";
import { fileURLToPath } from "node:url";
import type { OpenClawPluginConfigSchema } from "openclaw/plugin-sdk";

export const ACPX_PERMISSION_MODES = ["approve-all", "approve-reads", "deny-all"] as const;
export type AcpxPermissionMode = (typeof ACPX_PERMISSION_MODES)[number];

export const ACPX_NON_INTERACTIVE_POLICIES = ["deny", "fail"] as const;
export type AcpxNonInteractivePermissionPolicy = (typeof ACPX_NON_INTERACTIVE_POLICIES)[number];

export const ACPX_PINNED_VERSION = "0.1.15";
export const ACPX_VERSION_ANY = "any";
const ACPX_BIN_NAME = process.platform === "win32" ? "acpx.cmd" : "acpx";
export const ACPX_PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const ACPX_BUNDLED_BIN = path.join(ACPX_PLUGIN_ROOT, "node_modules", ".bin", ACPX_BIN_NAME);
export function buildAcpxLocalInstallCommand(version: string = ACPX_PINNED_VERSION): string {
  return `npm install --omit=dev --no-save acpx@${version}`;
}
export const ACPX_LOCAL_INSTALL_COMMAND = buildAcpxLocalInstallCommand();

export type AcpxPluginConfig = {
  command?: string;
  expectedVersion?: string;
  cwd?: string;
  permissionMode?: AcpxPermissionMode;
  nonInteractivePermissions?: AcpxNonInteractivePermissionPolicy;
  timeoutSeconds?: number;
  queueOwnerTtlSeconds?: number;
};

export type ResolvedAcpxPluginConfig = {
  command: string;
  expectedVersion?: string;
  allowPluginLocalInstall: boolean;
  installCommand: string;
  cwd: string;
  permissionMode: AcpxPermissionMode;
  nonInteractivePermissions: AcpxNonInteractivePermissionPolicy;
  timeoutSeconds?: number;
  queueOwnerTtlSeconds: number;
};

const DEFAULT_PERMISSION_MODE: AcpxPermissionMode = "approve-reads";
const DEFAULT_NON_INTERACTIVE_POLICY: AcpxNonInteractivePermissionPolicy = "fail";
const DEFAULT_QUEUE_OWNER_TTL_SECONDS = 0.1;

type ParseResult =
  | { ok: true; value: AcpxPluginConfig | undefined }
  | { ok: false; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPermissionMode(value: string): value is AcpxPermissionMode {
  return ACPX_PERMISSION_MODES.includes(value as AcpxPermissionMode);
}

function isNonInteractivePermissionPolicy(
  value: string,
): value is AcpxNonInteractivePermissionPolicy {
  return ACPX_NON_INTERACTIVE_POLICIES.includes(value as AcpxNonInteractivePermissionPolicy);
}

function parseAcpxPluginConfig(value: unknown): ParseResult {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  if (!isRecord(value)) {
    return { ok: false, message: "expected config object" };
  }
  const allowedKeys = new Set([
    "command",
    "expectedVersion",
    "cwd",
    "permissionMode",
    "nonInteractivePermissions",
    "timeoutSeconds",
    "queueOwnerTtlSeconds",
  ]);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      return { ok: false, message: `unknown config key: ${key}` };
    }
  }

  const command = value.command;
  if (command !== undefined && (typeof command !== "string" || command.trim() === "")) {
    return { ok: false, message: "command must be a non-empty string" };
  }

  const expectedVersion = value.expectedVersion;
  if (
    expectedVersion !== undefined &&
    (typeof expectedVersion !== "string" || expectedVersion.trim() === "")
  ) {
    return { ok: false, message: "expectedVersion must be a non-empty string" };
  }

  const cwd = value.cwd;
  if (cwd !== undefined && (typeof cwd !== "string" || cwd.trim() === "")) {
    return { ok: false, message: "cwd must be a non-empty string" };
  }

  const permissionMode = value.permissionMode;
  if (
    permissionMode !== undefined &&
    (typeof permissionMode !== "string" || !isPermissionMode(permissionMode))
  ) {
    return {
      ok: false,
      message: `permissionMode must be one of: ${ACPX_PERMISSION_MODES.join(", ")}`,
    };
  }

  const nonInteractivePermissions = value.nonInteractivePermissions;
  if (
    nonInteractivePermissions !== undefined &&
    (typeof nonInteractivePermissions !== "string" ||
      !isNonInteractivePermissionPolicy(nonInteractivePermissions))
  ) {
    return {
      ok: false,
      message: `nonInteractivePermissions must be one of: ${ACPX_NON_INTERACTIVE_POLICIES.join(", ")}`,
    };
  }

  const timeoutSeconds = value.timeoutSeconds;
  if (
    timeoutSeconds !== undefined &&
    (typeof timeoutSeconds !== "number" || !Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0)
  ) {
    return { ok: false, message: "timeoutSeconds must be a positive number" };
  }

  const queueOwnerTtlSeconds = value.queueOwnerTtlSeconds;
  if (
    queueOwnerTtlSeconds !== undefined &&
    (typeof queueOwnerTtlSeconds !== "number" ||
      !Number.isFinite(queueOwnerTtlSeconds) ||
      queueOwnerTtlSeconds < 0)
  ) {
    return { ok: false, message: "queueOwnerTtlSeconds must be a non-negative number" };
  }

  return {
    ok: true,
    value: {
      command: typeof command === "string" ? command.trim() : undefined,
      expectedVersion: typeof expectedVersion === "string" ? expectedVersion.trim() : undefined,
      cwd: typeof cwd === "string" ? cwd.trim() : undefined,
      permissionMode: typeof permissionMode === "string" ? permissionMode : undefined,
      nonInteractivePermissions:
        typeof nonInteractivePermissions === "string" ? nonInteractivePermissions : undefined,
      timeoutSeconds: typeof timeoutSeconds === "number" ? timeoutSeconds : undefined,
      queueOwnerTtlSeconds:
        typeof queueOwnerTtlSeconds === "number" ? queueOwnerTtlSeconds : undefined,
    },
  };
}

function resolveConfiguredCommand(params: { configured?: string; workspaceDir?: string }): string {
  const configured = params.configured?.trim();
  if (!configured) {
    return ACPX_BUNDLED_BIN;
  }
  if (path.isAbsolute(configured) || configured.includes(path.sep) || configured.includes("/")) {
    const baseDir = params.workspaceDir?.trim() || process.cwd();
    return path.resolve(baseDir, configured);
  }
  return configured;
}

export function createAcpxPluginConfigSchema(): OpenClawPluginConfigSchema {
  return {
    safeParse(value: unknown):
      | { success: true; data?: unknown }
      | {
          success: false;
          error: { issues: Array<{ path: Array<string | number>; message: string }> };
        } {
      const parsed = parseAcpxPluginConfig(value);
      if (parsed.ok) {
        return { success: true, data: parsed.value };
      }
      return {
        success: false,
        error: {
          issues: [{ path: [], message: parsed.message }],
        },
      };
    },
    jsonSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        command: { type: "string" },
        expectedVersion: { type: "string" },
        cwd: { type: "string" },
        permissionMode: {
          type: "string",
          enum: [...ACPX_PERMISSION_MODES],
        },
        nonInteractivePermissions: {
          type: "string",
          enum: [...ACPX_NON_INTERACTIVE_POLICIES],
        },
        timeoutSeconds: { type: "number", minimum: 0.001 },
        queueOwnerTtlSeconds: { type: "number", minimum: 0 },
      },
    },
  };
}

export function resolveAcpxPluginConfig(params: {
  rawConfig: unknown;
  workspaceDir?: string;
}): ResolvedAcpxPluginConfig {
  const parsed = parseAcpxPluginConfig(params.rawConfig);
  if (!parsed.ok) {
    throw new Error(parsed.message);
  }
  const normalized = parsed.value ?? {};
  const fallbackCwd = params.workspaceDir?.trim() || process.cwd();
  const cwd = path.resolve(normalized.cwd?.trim() || fallbackCwd);
  const command = resolveConfiguredCommand({
    configured: normalized.command,
    workspaceDir: params.workspaceDir,
  });
  const allowPluginLocalInstall = command === ACPX_BUNDLED_BIN;
  const configuredExpectedVersion = normalized.expectedVersion;
  const expectedVersion =
    configuredExpectedVersion === ACPX_VERSION_ANY
      ? undefined
      : (configuredExpectedVersion ?? (allowPluginLocalInstall ? ACPX_PINNED_VERSION : undefined));
  const installCommand = buildAcpxLocalInstallCommand(expectedVersion ?? ACPX_PINNED_VERSION);

  return {
    command,
    expectedVersion,
    allowPluginLocalInstall,
    installCommand,
    cwd,
    permissionMode: normalized.permissionMode ?? DEFAULT_PERMISSION_MODE,
    nonInteractivePermissions:
      normalized.nonInteractivePermissions ?? DEFAULT_NON_INTERACTIVE_POLICY,
    timeoutSeconds: normalized.timeoutSeconds,
    queueOwnerTtlSeconds: normalized.queueOwnerTtlSeconds ?? DEFAULT_QUEUE_OWNER_TTL_SECONDS,
  };
}
