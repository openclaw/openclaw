import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildPluginConfigSchema } from "openclaw/plugin-sdk/core";
import { z } from "openclaw/plugin-sdk/zod";
import type { OpenClawPluginConfigSchema } from "../runtime-api.js";

export const ACPX_PERMISSION_MODES = ["approve-all", "approve-reads", "deny-all"] as const;
export type AcpxPermissionMode = (typeof ACPX_PERMISSION_MODES)[number];

export const ACPX_NON_INTERACTIVE_POLICIES = ["deny", "fail"] as const;
export type AcpxNonInteractivePermissionPolicy = (typeof ACPX_NON_INTERACTIVE_POLICIES)[number];

export const ACPX_VERSION_ANY = "any";
const ACPX_BIN_NAME = process.platform === "win32" ? "acpx.cmd" : "acpx";

function isAcpxPluginRoot(dir: string): boolean {
  return (
    fs.existsSync(path.join(dir, "openclaw.plugin.json")) &&
    fs.existsSync(path.join(dir, "package.json"))
  );
}

function resolveNearestAcpxPluginRoot(moduleUrl: string): string {
  let cursor = path.dirname(fileURLToPath(moduleUrl));
  for (let i = 0; i < 3; i += 1) {
    // Bundled entries live at the plugin root while source files still live under src/.
    if (isAcpxPluginRoot(cursor)) {
      return cursor;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      break;
    }
    cursor = parent;
  }
  return path.resolve(path.dirname(fileURLToPath(moduleUrl)), "..");
}

function resolveWorkspaceAcpxPluginRoot(currentRoot: string): string | null {
  if (
    path.basename(currentRoot) !== "acpx" ||
    path.basename(path.dirname(currentRoot)) !== "extensions" ||
    path.basename(path.dirname(path.dirname(currentRoot))) !== "dist"
  ) {
    return null;
  }
  const workspaceRoot = path.resolve(currentRoot, "..", "..", "..", "extensions", "acpx");
  return isAcpxPluginRoot(workspaceRoot) ? workspaceRoot : null;
}

export function resolveAcpxPluginRoot(moduleUrl: string = import.meta.url): string {
  const resolvedRoot = resolveNearestAcpxPluginRoot(moduleUrl);
  // In a live repo checkout, dist/ can be rebuilt out from under the running gateway.
  // Prefer the stable source plugin root when a built extension is running beside it.
  return resolveWorkspaceAcpxPluginRoot(resolvedRoot) ?? resolvedRoot;
}

export const ACPX_PLUGIN_ROOT = resolveAcpxPluginRoot();
const pluginPkg = JSON.parse(fs.readFileSync(path.join(ACPX_PLUGIN_ROOT, "package.json"), "utf8"));
export const ACPX_PINNED_VERSION: string = pluginPkg.dependencies.acpx;
export const ACPX_BUNDLED_BIN = path.join(ACPX_PLUGIN_ROOT, "node_modules", ".bin", ACPX_BIN_NAME);
export function buildAcpxLocalInstallCommand(version: string = ACPX_PINNED_VERSION): string {
  return `npm install --omit=dev --no-save --package-lock=false acpx@${version}`;
}
export const ACPX_LOCAL_INSTALL_COMMAND = buildAcpxLocalInstallCommand();

export type McpServerConfig = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
};

export type AcpxMcpServer = {
  name: string;
  command: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
};

export type AcpxPluginConfig = {
  command?: string;
  expectedVersion?: string;
  cwd?: string;
  permissionMode?: AcpxPermissionMode;
  nonInteractivePermissions?: AcpxNonInteractivePermissionPolicy;
  strictWindowsCmdWrapper?: boolean;
  timeoutSeconds?: number;
  queueOwnerTtlSeconds?: number;
  mcpServers?: Record<string, McpServerConfig>;
};

export type ResolvedAcpxPluginConfig = {
  command: string;
  expectedVersion?: string;
  allowPluginLocalInstall: boolean;
  stripProviderAuthEnvVars: boolean;
  installCommand: string;
  cwd: string;
  permissionMode: AcpxPermissionMode;
  nonInteractivePermissions: AcpxNonInteractivePermissionPolicy;
  strictWindowsCmdWrapper: boolean;
  timeoutSeconds?: number;
  queueOwnerTtlSeconds: number;
  mcpServers: Record<string, McpServerConfig>;
};

const DEFAULT_PERMISSION_MODE: AcpxPermissionMode = "approve-reads";
const DEFAULT_NON_INTERACTIVE_POLICY: AcpxNonInteractivePermissionPolicy = "fail";
const DEFAULT_QUEUE_OWNER_TTL_SECONDS = 0.1;
const DEFAULT_STRICT_WINDOWS_CMD_WRAPPER = true;

type ParseResult =
  | { ok: true; value: AcpxPluginConfig | undefined }
  | { ok: false; message: string };

const nonEmptyTrimmedString = (message: string) =>
  z.string({ error: message }).trim().min(1, { error: message });

const McpServerConfigSchema = z.object({
  command: nonEmptyTrimmedString("command must be a non-empty string").describe(
    "Command to run the MCP server",
  ),
  args: z
    .array(z.string({ error: "args must be an array of strings" }), {
      error: "args must be an array of strings",
    })
    .optional()
    .describe("Arguments to pass to the command"),
  env: z
    .record(z.string(), z.string({ error: "env values must be strings" }), {
      error: "env must be an object of strings",
    })
    .optional()
    .describe("Environment variables for the MCP server"),
});

const AcpxPluginConfigSchema = z.strictObject({
  command: nonEmptyTrimmedString("command must be a non-empty string").optional(),
  expectedVersion: nonEmptyTrimmedString("expectedVersion must be a non-empty string").optional(),
  cwd: nonEmptyTrimmedString("cwd must be a non-empty string").optional(),
  permissionMode: z
    .enum(ACPX_PERMISSION_MODES, {
      error: `permissionMode must be one of: ${ACPX_PERMISSION_MODES.join(", ")}`,
    })
    .optional(),
  nonInteractivePermissions: z
    .enum(ACPX_NON_INTERACTIVE_POLICIES, {
      error: `nonInteractivePermissions must be one of: ${ACPX_NON_INTERACTIVE_POLICIES.join(", ")}`,
    })
    .optional(),
  strictWindowsCmdWrapper: z
    .boolean({ error: "strictWindowsCmdWrapper must be a boolean" })
    .optional(),
  timeoutSeconds: z
    .number({ error: "timeoutSeconds must be a number >= 0.001" })
    .min(0.001, { error: "timeoutSeconds must be a number >= 0.001" })
    .optional(),
  queueOwnerTtlSeconds: z
    .number({ error: "queueOwnerTtlSeconds must be a number >= 0" })
    .min(0, { error: "queueOwnerTtlSeconds must be a number >= 0" })
    .optional(),
  mcpServers: z.record(z.string(), McpServerConfigSchema).optional(),
});

function formatAcpxConfigIssue(issue: z.ZodIssue | undefined): string {
  if (!issue) {
    return "invalid config";
  }
  if (issue.code === "unrecognized_keys" && issue.keys.length > 0) {
    return `unknown config key: ${issue.keys[0]}`;
  }
  if (issue.code === "invalid_type" && issue.path.length === 0) {
    return "expected config object";
  }
  return issue.message;
}

function parseAcpxPluginConfig(value: unknown): ParseResult {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  const parsed = AcpxPluginConfigSchema.safeParse(value);
  if (!parsed.success) {
    return { ok: false, message: formatAcpxConfigIssue(parsed.error.issues[0]) };
  }
  return {
    ok: true,
    value: parsed.data as AcpxPluginConfig,
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
  return buildPluginConfigSchema(AcpxPluginConfigSchema);
}

export function toAcpMcpServers(mcpServers: Record<string, McpServerConfig>): AcpxMcpServer[] {
  return Object.entries(mcpServers).map(([name, server]) => ({
    name,
    command: server.command,
    args: [...(server.args ?? [])],
    env: Object.entries(server.env ?? {}).map(([envName, value]) => ({
      name: envName,
      value,
    })),
  }));
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
  const stripProviderAuthEnvVars = command === ACPX_BUNDLED_BIN;
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
    stripProviderAuthEnvVars,
    installCommand,
    cwd,
    permissionMode: normalized.permissionMode ?? DEFAULT_PERMISSION_MODE,
    nonInteractivePermissions:
      normalized.nonInteractivePermissions ?? DEFAULT_NON_INTERACTIVE_POLICY,
    strictWindowsCmdWrapper:
      normalized.strictWindowsCmdWrapper ?? DEFAULT_STRICT_WINDOWS_CMD_WRAPPER,
    timeoutSeconds: normalized.timeoutSeconds,
    queueOwnerTtlSeconds: normalized.queueOwnerTtlSeconds ?? DEFAULT_QUEUE_OWNER_TTL_SECONDS,
    mcpServers: normalized.mcpServers ?? {},
  };
}
