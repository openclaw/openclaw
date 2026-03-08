import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { OpenClawEnvConfigSchema, type OpenClawEnvConfig } from "./schema.js";

export type ResolvedExtraMount = {
  hostPath: string;
  container: string;
  mode: "ro" | "rw";
};

export type ResolvedWorkspaceWriteMount = {
  subpath: string;
  hostPath: string;
  containerPath: string;
};

export type ResolvedDockerSecret = {
  name: string;
  filePath: string;
};

export type ResolvedOpenClawEnvConfig = {
  schema_version: OpenClawEnvConfig["schema_version"];
  configPath: string;
  configDir: string;
  outputDir: string;
  projectName: string;
  openclaw: OpenClawEnvConfig["openclaw"];
  workspace: {
    hostPath: string;
    mode: "ro" | "rw";
    writeAllowlist: ResolvedWorkspaceWriteMount[];
  };
  mounts: ResolvedExtraMount[];
  network: OpenClawEnvConfig["network"];
  secrets: {
    mode: OpenClawEnvConfig["secrets"]["mode"];
    envFilePath: string;
    dockerSecrets: ResolvedDockerSecret[];
  };
  limits: OpenClawEnvConfig["limits"];
  runtime: OpenClawEnvConfig["runtime"];
  writeGuards: {
    enabled: boolean;
    maxFileWrites?: number;
    maxBytesWritten?: number;
    dryRunAudit: boolean;
    pollIntervalMs: number;
  };
  generated: {
    composePath: string;
    openclawConfigPath: string;
    allowlistPath: string;
    proxyDir: string;
    proxyServerPath: string;
    proxyDockerfilePath: string;
    writeGuardRunnerPath: string;
  };
};

function expandTilde(inputPath: string): string {
  const trimmed = inputPath.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (trimmed === "~") {
    return os.homedir();
  }
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return path.join(os.homedir(), trimmed.slice(2));
  }
  return trimmed;
}

function resolveHostPath(baseDir: string, inputPath: string): string {
  return path.resolve(baseDir, expandTilde(inputPath));
}

function normalizeWorkspaceSubpath(inputPath: string): string {
  const normalized = inputPath.trim().replace(/\\/g, "/");
  const out = path.posix.normalize(normalized);
  if (!out || out === "." || out === "..") {
    throw new Error(`Invalid workspace.write_allowlist path: ${inputPath}`);
  }
  if (out.startsWith("../") || out.includes("/../")) {
    throw new Error(`workspace.write_allowlist escapes workspace: ${inputPath}`);
  }
  return out.replace(/^\/+/, "");
}

function isSameOrChild(childPath: string, parentPath: string): boolean {
  const rel = path.relative(parentPath, childPath);
  if (!rel) {
    return true;
  }
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

function resolveProjectName(configDir: string): string {
  const base = path
    .basename(configDir)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const hash = crypto.createHash("sha256").update(configDir).digest("hex").slice(0, 8);
  const prefix = "openclaw-env";
  const basePart = base || "project";
  const name = `${prefix}-${basePart}-${hash}`;
  // Docker/Compose resource names are commonly limited to 63 chars; keep it conservative.
  if (name.length <= 63) {
    return name;
  }
  const maxBaseLen = Math.max(8, 63 - (prefix.length + 1 + 1 + hash.length)); // prefix-base-hash
  return `${prefix}-${basePart.slice(0, maxBaseLen)}-${hash}`;
}

export function resolveDefaultConfigPath(cwd: string): string {
  return path.resolve(cwd, "openclaw.env.yml");
}

export async function loadOpenClawEnvConfig(options: {
  cwd: string;
  configPath?: string;
}): Promise<ResolvedOpenClawEnvConfig> {
  const configPath = options.configPath
    ? path.resolve(options.cwd, options.configPath)
    : resolveDefaultConfigPath(options.cwd);
  const configDir = path.dirname(configPath);

  let raw: string;
  try {
    raw = await fs.readFile(configPath, "utf-8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read config: ${configPath}\n${message}`, { cause: err });
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse YAML: ${configPath}\n${message}`, { cause: err });
  }

  const validated = OpenClawEnvConfigSchema.safeParse(parsed);
  if (!validated.success) {
    const issues = validated.error.issues
      .map((iss) => `- ${iss.path.join(".") || "<root>"}: ${iss.message}`)
      .join("\n");
    throw new Error(`Invalid config: ${configPath}\n${issues}`);
  }

  const cfg = validated.data;

  const outputDir = path.join(configDir, ".openclaw-env");
  const projectName = resolveProjectName(configDir);

  const workspacePath = resolveHostPath(configDir, cfg.workspace.path);
  const workspaceWriteAllowlist: ResolvedWorkspaceWriteMount[] = [];
  const seenWorkspaceWriteMounts = new Set<string>();
  for (const rawSubpath of cfg.workspace.write_allowlist) {
    const normalizedSubpath = normalizeWorkspaceSubpath(rawSubpath);
    if (seenWorkspaceWriteMounts.has(normalizedSubpath)) {
      continue;
    }
    seenWorkspaceWriteMounts.add(normalizedSubpath);
    const hostPath = path.resolve(workspacePath, normalizedSubpath);
    if (!isSameOrChild(hostPath, workspacePath)) {
      throw new Error(`workspace.write_allowlist escapes workspace: ${rawSubpath}`);
    }
    workspaceWriteAllowlist.push({
      subpath: normalizedSubpath,
      hostPath,
      containerPath: `/workspace/${normalizedSubpath}`,
    });
  }

  const mounts: ResolvedExtraMount[] = cfg.mounts.map((m) => ({
    hostPath: resolveHostPath(configDir, m.host),
    container: m.container,
    mode: m.mode,
  }));

  const envFilePath = resolveHostPath(configDir, cfg.secrets.env_file);
  const dockerSecrets: ResolvedDockerSecret[] = cfg.secrets.docker_secrets.map((s) => ({
    name: s.name,
    filePath: resolveHostPath(configDir, s.file),
  }));

  const composePath = path.join(outputDir, "docker-compose.yml");
  const openclawConfigPath = path.join(outputDir, "openclaw.config.json5");
  const allowlistPath = path.join(outputDir, "allowlist.txt");
  const proxyDir = path.join(outputDir, "proxy");
  const proxyServerPath = path.join(proxyDir, "server.mjs");
  const proxyDockerfilePath = path.join(proxyDir, "Dockerfile");
  const writeGuardRunnerPath = path.join(outputDir, "write-guard.mjs");

  const writeGuardsEnabled =
    cfg.write_guards.enabled ||
    cfg.write_guards.dry_run_audit ||
    cfg.write_guards.max_file_writes !== undefined ||
    cfg.write_guards.max_bytes_written !== undefined;

  return {
    schema_version: cfg.schema_version,
    configPath,
    configDir,
    outputDir,
    projectName,
    openclaw: cfg.openclaw,
    workspace: {
      hostPath: workspacePath,
      mode: cfg.workspace.mode,
      writeAllowlist: workspaceWriteAllowlist,
    },
    mounts,
    network: cfg.network,
    secrets: {
      mode: cfg.secrets.mode,
      envFilePath,
      dockerSecrets,
    },
    limits: cfg.limits,
    runtime: cfg.runtime,
    writeGuards: {
      enabled: writeGuardsEnabled,
      maxFileWrites: cfg.write_guards.max_file_writes,
      maxBytesWritten: cfg.write_guards.max_bytes_written,
      dryRunAudit: cfg.write_guards.dry_run_audit,
      pollIntervalMs: cfg.write_guards.poll_interval_ms,
    },
    generated: {
      composePath,
      openclawConfigPath,
      allowlistPath,
      proxyDir,
      proxyServerPath,
      proxyDockerfilePath,
      writeGuardRunnerPath,
    },
  };
}
