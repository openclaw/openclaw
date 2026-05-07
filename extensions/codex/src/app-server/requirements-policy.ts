import { readFileSync } from "node:fs";
import path from "node:path";

export function defaultCodexRequirementsPolicyPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") {
    return path.win32.join(
      env.ProgramData ?? env.PROGRAMDATA ?? "C:\\ProgramData",
      "OpenAI",
      "Codex",
      "requirements.toml",
    );
  }
  return "/etc/codex/requirements.toml";
}

export const DEFAULT_CODEX_REQUIREMENTS_POLICY_PATH = defaultCodexRequirementsPolicyPath();

export type CodexAppServerSandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export type CodexRequirementsPolicy = {
  sourcePath: string;
  allowedSandboxModes?: CodexAppServerSandboxMode[];
};

export type CodexRequirementsPolicyReadOptions = {
  sourcePath?: string;
  readFile?: (path: string) => string;
};

const SANDBOX_MODE_NAMES: Record<string, CodexAppServerSandboxMode> = {
  readonly: "read-only",
  "read-only": "read-only",
  read_only: "read-only",
  readOnly: "read-only",
  ReadOnly: "read-only",
  workspacewrite: "workspace-write",
  "workspace-write": "workspace-write",
  workspace_write: "workspace-write",
  workspaceWrite: "workspace-write",
  WorkspaceWrite: "workspace-write",
  dangerfullaccess: "danger-full-access",
  "danger-full-access": "danger-full-access",
  danger_full_access: "danger-full-access",
  dangerFullAccess: "danger-full-access",
  DangerFullAccess: "danger-full-access",
};

export class CodexRequirementsPolicyConflictError extends Error {
  readonly sourcePath: string;
  readonly allowedSandboxModes: CodexAppServerSandboxMode[];
  readonly requestedSandboxMode: CodexAppServerSandboxMode;

  constructor(params: {
    sourcePath: string;
    allowedSandboxModes: CodexAppServerSandboxMode[];
    requestedSandboxMode: CodexAppServerSandboxMode;
    reason: string;
  }) {
    super(
      `Codex app-server permissions conflict: ${params.reason}. ${formatPolicyAllowance(params)}.`,
    );
    this.name = "CodexRequirementsPolicyConflictError";
    this.sourcePath = params.sourcePath;
    this.allowedSandboxModes = params.allowedSandboxModes;
    this.requestedSandboxMode = params.requestedSandboxMode;
  }
}

export function readCodexRequirementsPolicy(
  options: CodexRequirementsPolicyReadOptions = {},
): CodexRequirementsPolicy | undefined {
  const sourcePath = options.sourcePath ?? DEFAULT_CODEX_REQUIREMENTS_POLICY_PATH;
  let text: string;
  try {
    text = options.readFile ? options.readFile(sourcePath) : readFileSync(sourcePath, "utf8");
  } catch {
    return undefined;
  }
  return parseCodexRequirementsPolicy(text, { sourcePath });
}

export function parseCodexRequirementsPolicy(
  text: string,
  options: { sourcePath?: string } = {},
): CodexRequirementsPolicy {
  const sourcePath = options.sourcePath ?? DEFAULT_CODEX_REQUIREMENTS_POLICY_PATH;
  const match = stripTomlComments(text).match(/^\s*allowed_sandbox_modes\s*=\s*\[([^\]]*)\]/im);
  if (!match) {
    return { sourcePath };
  }
  const allowedSandboxModes = match[1]
    .match(/"([^"]+)"|'([^']+)'|([A-Za-z][A-Za-z0-9_-]*)/g)
    ?.map((value) => normalizeCodexSandboxMode(value.replace(/^["']|["']$/g, "")))
    .filter((value): value is CodexAppServerSandboxMode => Boolean(value));

  return {
    sourcePath,
    ...(allowedSandboxModes && allowedSandboxModes.length > 0
      ? { allowedSandboxModes: [...new Set(allowedSandboxModes)] }
      : {}),
  };
}

function stripTomlComments(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => {
      let quote: '"' | "'" | undefined;
      for (let index = 0; index < line.length; index += 1) {
        const char = line[index];
        if (quote) {
          if (char === quote && line[index - 1] !== "\\") {
            quote = undefined;
          }
          continue;
        }
        if (char === '"' || char === "'") {
          quote = char;
          continue;
        }
        if (char === "#") {
          return line.slice(0, index);
        }
      }
      return line;
    })
    .join("\n");
}

export function normalizeCodexSandboxMode(value: string): CodexAppServerSandboxMode | undefined {
  const trimmed = value.trim();
  return SANDBOX_MODE_NAMES[trimmed] ?? SANDBOX_MODE_NAMES[trimmed.toLowerCase()];
}

export function isCodexSandboxAllowedByPolicy(
  policy: CodexRequirementsPolicy | undefined,
  sandbox: CodexAppServerSandboxMode,
): boolean {
  if (!policy?.allowedSandboxModes) {
    return true;
  }
  return policy.allowedSandboxModes.includes(sandbox);
}

export function preferredCodexSandboxForPolicy(
  policy: CodexRequirementsPolicy | undefined,
): CodexAppServerSandboxMode {
  if (!policy?.allowedSandboxModes) {
    return "danger-full-access";
  }
  if (policy.allowedSandboxModes.includes("workspace-write")) {
    return "workspace-write";
  }
  if (policy.allowedSandboxModes.includes("read-only")) {
    return "read-only";
  }
  return policy.allowedSandboxModes[0] ?? "read-only";
}

export function classifyCodexRequirementsPolicyError(
  error: unknown,
): { message: string } | undefined {
  if (error instanceof CodexRequirementsPolicyConflictError) {
    return { message: error.message };
  }
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : undefined;
  if (!message) {
    return undefined;
  }
  const match = message.match(
    /invalid value for `sandbox_mode`: `([^`]+)` is not in the allowed set \[([^\]]*)\] \(set by ([^)]+)\)/i,
  );
  if (!match) {
    return undefined;
  }
  const requested = normalizeCodexSandboxMode(match[1]) ?? match[1];
  const allowed = match[2]
    .split(",")
    .map((value) => normalizeCodexSandboxMode(value.trim()) ?? value.trim())
    .filter(Boolean)
    .join(", ");
  return {
    message: `Codex app-server permissions conflict: requested sandbox ${requested} is blocked by ${match[3]} (allowed: ${allowed}). Use /codex permissions default or configure a compatible appServer permission tuple.`,
  };
}

export function formatPolicyAllowance(params: {
  sourcePath: string;
  allowedSandboxModes: CodexAppServerSandboxMode[];
}): string {
  return `${params.sourcePath} allows sandbox modes: ${params.allowedSandboxModes.join(", ")}`;
}
