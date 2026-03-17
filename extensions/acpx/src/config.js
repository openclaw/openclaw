import path from "node:path";
import { fileURLToPath } from "node:url";
const ACPX_PERMISSION_MODES = ["approve-all", "approve-reads", "deny-all"];
const ACPX_NON_INTERACTIVE_POLICIES = ["deny", "fail"];
const ACPX_PINNED_VERSION = "0.1.16";
const ACPX_VERSION_ANY = "any";
const ACPX_BIN_NAME = process.platform === "win32" ? "acpx.cmd" : "acpx";
const ACPX_PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ACPX_BUNDLED_BIN = path.join(ACPX_PLUGIN_ROOT, "node_modules", ".bin", ACPX_BIN_NAME);
function buildAcpxLocalInstallCommand(version = ACPX_PINNED_VERSION) {
  return `npm install --omit=dev --no-save acpx@${version}`;
}
const ACPX_LOCAL_INSTALL_COMMAND = buildAcpxLocalInstallCommand();
const DEFAULT_PERMISSION_MODE = "approve-reads";
const DEFAULT_NON_INTERACTIVE_POLICY = "fail";
const DEFAULT_QUEUE_OWNER_TTL_SECONDS = 0.1;
const DEFAULT_STRICT_WINDOWS_CMD_WRAPPER = true;
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isPermissionMode(value) {
  return ACPX_PERMISSION_MODES.includes(value);
}
function isNonInteractivePermissionPolicy(value) {
  return ACPX_NON_INTERACTIVE_POLICIES.includes(value);
}
function isMcpServerConfig(value) {
  if (!isRecord(value)) {
    return false;
  }
  if (typeof value.command !== "string" || value.command.trim() === "") {
    return false;
  }
  if (value.args !== void 0) {
    if (!Array.isArray(value.args)) {
      return false;
    }
    for (const arg of value.args) {
      if (typeof arg !== "string") {
        return false;
      }
    }
  }
  if (value.env !== void 0) {
    if (!isRecord(value.env)) {
      return false;
    }
    for (const envValue of Object.values(value.env)) {
      if (typeof envValue !== "string") {
        return false;
      }
    }
  }
  return true;
}
function parseAcpxPluginConfig(value) {
  if (value === void 0) {
    return { ok: true, value: void 0 };
  }
  if (!isRecord(value)) {
    return { ok: false, message: "expected config object" };
  }
  const allowedKeys = /* @__PURE__ */ new Set([
    "command",
    "expectedVersion",
    "cwd",
    "permissionMode",
    "nonInteractivePermissions",
    "strictWindowsCmdWrapper",
    "timeoutSeconds",
    "queueOwnerTtlSeconds",
    "mcpServers"
  ]);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      return { ok: false, message: `unknown config key: ${key}` };
    }
  }
  const command = value.command;
  if (command !== void 0 && (typeof command !== "string" || command.trim() === "")) {
    return { ok: false, message: "command must be a non-empty string" };
  }
  const expectedVersion = value.expectedVersion;
  if (expectedVersion !== void 0 && (typeof expectedVersion !== "string" || expectedVersion.trim() === "")) {
    return { ok: false, message: "expectedVersion must be a non-empty string" };
  }
  const cwd = value.cwd;
  if (cwd !== void 0 && (typeof cwd !== "string" || cwd.trim() === "")) {
    return { ok: false, message: "cwd must be a non-empty string" };
  }
  const permissionMode = value.permissionMode;
  if (permissionMode !== void 0 && (typeof permissionMode !== "string" || !isPermissionMode(permissionMode))) {
    return {
      ok: false,
      message: `permissionMode must be one of: ${ACPX_PERMISSION_MODES.join(", ")}`
    };
  }
  const nonInteractivePermissions = value.nonInteractivePermissions;
  if (nonInteractivePermissions !== void 0 && (typeof nonInteractivePermissions !== "string" || !isNonInteractivePermissionPolicy(nonInteractivePermissions))) {
    return {
      ok: false,
      message: `nonInteractivePermissions must be one of: ${ACPX_NON_INTERACTIVE_POLICIES.join(", ")}`
    };
  }
  const timeoutSeconds = value.timeoutSeconds;
  if (timeoutSeconds !== void 0 && (typeof timeoutSeconds !== "number" || !Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0)) {
    return { ok: false, message: "timeoutSeconds must be a positive number" };
  }
  const strictWindowsCmdWrapper = value.strictWindowsCmdWrapper;
  if (strictWindowsCmdWrapper !== void 0 && typeof strictWindowsCmdWrapper !== "boolean") {
    return { ok: false, message: "strictWindowsCmdWrapper must be a boolean" };
  }
  const queueOwnerTtlSeconds = value.queueOwnerTtlSeconds;
  if (queueOwnerTtlSeconds !== void 0 && (typeof queueOwnerTtlSeconds !== "number" || !Number.isFinite(queueOwnerTtlSeconds) || queueOwnerTtlSeconds < 0)) {
    return { ok: false, message: "queueOwnerTtlSeconds must be a non-negative number" };
  }
  const mcpServers = value.mcpServers;
  if (mcpServers !== void 0) {
    if (!isRecord(mcpServers)) {
      return { ok: false, message: "mcpServers must be an object" };
    }
    for (const [key, serverConfig] of Object.entries(mcpServers)) {
      if (!isMcpServerConfig(serverConfig)) {
        return {
          ok: false,
          message: `mcpServers.${key} must have a command string, optional args array, and optional env object`
        };
      }
    }
  }
  return {
    ok: true,
    value: {
      command: typeof command === "string" ? command.trim() : void 0,
      expectedVersion: typeof expectedVersion === "string" ? expectedVersion.trim() : void 0,
      cwd: typeof cwd === "string" ? cwd.trim() : void 0,
      permissionMode: typeof permissionMode === "string" ? permissionMode : void 0,
      nonInteractivePermissions: typeof nonInteractivePermissions === "string" ? nonInteractivePermissions : void 0,
      strictWindowsCmdWrapper: typeof strictWindowsCmdWrapper === "boolean" ? strictWindowsCmdWrapper : void 0,
      timeoutSeconds: typeof timeoutSeconds === "number" ? timeoutSeconds : void 0,
      queueOwnerTtlSeconds: typeof queueOwnerTtlSeconds === "number" ? queueOwnerTtlSeconds : void 0,
      mcpServers
    }
  };
}
function resolveConfiguredCommand(params) {
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
function createAcpxPluginConfigSchema() {
  return {
    safeParse(value) {
      const parsed = parseAcpxPluginConfig(value);
      if (parsed.ok) {
        return { success: true, data: parsed.value };
      }
      return {
        success: false,
        error: {
          issues: [{ path: [], message: parsed.message }]
        }
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
          enum: [...ACPX_PERMISSION_MODES]
        },
        nonInteractivePermissions: {
          type: "string",
          enum: [...ACPX_NON_INTERACTIVE_POLICIES]
        },
        strictWindowsCmdWrapper: { type: "boolean" },
        timeoutSeconds: { type: "number", minimum: 1e-3 },
        queueOwnerTtlSeconds: { type: "number", minimum: 0 },
        mcpServers: {
          type: "object",
          additionalProperties: {
            type: "object",
            properties: {
              command: { type: "string" },
              args: {
                type: "array",
                items: { type: "string" }
              },
              env: {
                type: "object",
                additionalProperties: { type: "string" }
              }
            },
            required: ["command"]
          }
        }
      }
    }
  };
}
function toAcpMcpServers(mcpServers) {
  return Object.entries(mcpServers).map(([name, server]) => ({
    name,
    command: server.command,
    args: [...server.args ?? []],
    env: Object.entries(server.env ?? {}).map(([envName, value]) => ({
      name: envName,
      value
    }))
  }));
}
function resolveAcpxPluginConfig(params) {
  const parsed = parseAcpxPluginConfig(params.rawConfig);
  if (!parsed.ok) {
    throw new Error(parsed.message);
  }
  const normalized = parsed.value ?? {};
  const fallbackCwd = params.workspaceDir?.trim() || process.cwd();
  const cwd = path.resolve(normalized.cwd?.trim() || fallbackCwd);
  const command = resolveConfiguredCommand({
    configured: normalized.command,
    workspaceDir: params.workspaceDir
  });
  const allowPluginLocalInstall = command === ACPX_BUNDLED_BIN;
  const stripProviderAuthEnvVars = command === ACPX_BUNDLED_BIN;
  const configuredExpectedVersion = normalized.expectedVersion;
  const expectedVersion = configuredExpectedVersion === ACPX_VERSION_ANY ? void 0 : configuredExpectedVersion ?? (allowPluginLocalInstall ? ACPX_PINNED_VERSION : void 0);
  const installCommand = buildAcpxLocalInstallCommand(expectedVersion ?? ACPX_PINNED_VERSION);
  return {
    command,
    expectedVersion,
    allowPluginLocalInstall,
    stripProviderAuthEnvVars,
    installCommand,
    cwd,
    permissionMode: normalized.permissionMode ?? DEFAULT_PERMISSION_MODE,
    nonInteractivePermissions: normalized.nonInteractivePermissions ?? DEFAULT_NON_INTERACTIVE_POLICY,
    strictWindowsCmdWrapper: normalized.strictWindowsCmdWrapper ?? DEFAULT_STRICT_WINDOWS_CMD_WRAPPER,
    timeoutSeconds: normalized.timeoutSeconds,
    queueOwnerTtlSeconds: normalized.queueOwnerTtlSeconds ?? DEFAULT_QUEUE_OWNER_TTL_SECONDS,
    mcpServers: normalized.mcpServers ?? {}
  };
}
export {
  ACPX_BUNDLED_BIN,
  ACPX_LOCAL_INSTALL_COMMAND,
  ACPX_NON_INTERACTIVE_POLICIES,
  ACPX_PERMISSION_MODES,
  ACPX_PINNED_VERSION,
  ACPX_PLUGIN_ROOT,
  ACPX_VERSION_ANY,
  buildAcpxLocalInstallCommand,
  createAcpxPluginConfigSchema,
  resolveAcpxPluginConfig,
  toAcpMcpServers
};
