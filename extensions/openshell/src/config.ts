import path from "node:path";
import type { OpenClawPluginConfigSchema } from "openclaw/plugin-sdk/core";

export type OpenShellPluginConfig = {
  command?: string;
  gateway?: string;
  gatewayEndpoint?: string;
  from?: string;
  policy?: string;
  providers?: string[];
  gpu?: boolean;
  autoProviders?: boolean;
  remoteWorkspaceDir?: string;
  remoteAgentWorkspaceDir?: string;
  timeoutSeconds?: number;
};

export type ResolvedOpenShellPluginConfig = {
  command: string;
  gateway?: string;
  gatewayEndpoint?: string;
  from: string;
  policy?: string;
  providers: string[];
  gpu: boolean;
  autoProviders: boolean;
  remoteWorkspaceDir: string;
  remoteAgentWorkspaceDir: string;
  timeoutMs: number;
};

const DEFAULT_COMMAND = "openshell";
const DEFAULT_SOURCE = "openclaw";
const DEFAULT_REMOTE_WORKSPACE_DIR = "/sandbox";
const DEFAULT_REMOTE_AGENT_WORKSPACE_DIR = "/agent";
const DEFAULT_TIMEOUT_MS = 120_000;

type ParseSuccess = { success: true; data?: OpenShellPluginConfig };
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

function normalizeProviders(value: unknown): string[] | null {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    return null;
  }
  const seen = new Set<string>();
  const providers: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !entry.trim()) {
      return null;
    }
    const normalized = entry.trim();
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    providers.push(normalized);
  }
  return providers;
}

function normalizeRemotePath(value: string | undefined, fallback: string): string {
  const candidate = value ?? fallback;
  const normalized = path.posix.normalize(candidate.trim() || fallback);
  if (!normalized.startsWith("/")) {
    throw new Error(`OpenShell remote path must be absolute: ${candidate}`);
  }
  return normalized;
}

export function createOpenShellPluginConfigSchema(): OpenClawPluginConfigSchema {
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
    const allowedKeys = new Set([
      "command",
      "gateway",
      "gatewayEndpoint",
      "from",
      "policy",
      "providers",
      "gpu",
      "autoProviders",
      "remoteWorkspaceDir",
      "remoteAgentWorkspaceDir",
      "timeoutSeconds",
    ]);
    for (const key of Object.keys(value)) {
      if (!allowedKeys.has(key)) {
        return {
          success: false,
          error: { issues: [{ path: [key], message: `unknown config key: ${key}` }] },
        };
      }
    }

    const providers = normalizeProviders(value.providers);
    if (providers === null) {
      return {
        success: false,
        error: {
          issues: [{ path: ["providers"], message: "providers must be an array of strings" }],
        },
      };
    }

    const timeoutSeconds = value.timeoutSeconds;
    if (
      timeoutSeconds !== undefined &&
      (typeof timeoutSeconds !== "number" || !Number.isFinite(timeoutSeconds) || timeoutSeconds < 1)
    ) {
      return {
        success: false,
        error: {
          issues: [{ path: ["timeoutSeconds"], message: "timeoutSeconds must be a number >= 1" }],
        },
      };
    }

    for (const key of ["gpu", "autoProviders"] as const) {
      const candidate = value[key];
      if (candidate !== undefined && typeof candidate !== "boolean") {
        return {
          success: false,
          error: { issues: [{ path: [key], message: `${key} must be a boolean` }] },
        };
      }
    }

    return {
      success: true,
      data: {
        command: trimString(value.command),
        gateway: trimString(value.gateway),
        gatewayEndpoint: trimString(value.gatewayEndpoint),
        from: trimString(value.from),
        policy: trimString(value.policy),
        providers,
        gpu: value.gpu as boolean | undefined,
        autoProviders: value.autoProviders as boolean | undefined,
        remoteWorkspaceDir: trimString(value.remoteWorkspaceDir),
        remoteAgentWorkspaceDir: trimString(value.remoteAgentWorkspaceDir),
        timeoutSeconds: timeoutSeconds as number | undefined,
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
        gateway: { type: "string" },
        gatewayEndpoint: { type: "string" },
        from: { type: "string" },
        policy: { type: "string" },
        providers: { type: "array", items: { type: "string" } },
        gpu: { type: "boolean" },
        autoProviders: { type: "boolean" },
        remoteWorkspaceDir: { type: "string" },
        remoteAgentWorkspaceDir: { type: "string" },
        timeoutSeconds: { type: "number", minimum: 1 },
      },
    },
  };
}

export function resolveOpenShellPluginConfig(value: unknown): ResolvedOpenShellPluginConfig {
  const parsed = createOpenShellPluginConfigSchema().safeParse?.(value);
  if (!parsed || !parsed.success) {
    const issues = parsed && !parsed.success ? parsed.error?.issues : undefined;
    const message =
      issues?.map((issue: { message: string }) => issue.message).join(", ") || "invalid config";
    throw new Error(`Invalid openshell plugin config: ${message}`);
  }
  const raw = parsed.data ?? {};
  const cfg = (raw ?? {}) as OpenShellPluginConfig;
  return {
    command: cfg.command ?? DEFAULT_COMMAND,
    gateway: cfg.gateway,
    gatewayEndpoint: cfg.gatewayEndpoint,
    from: cfg.from ?? DEFAULT_SOURCE,
    policy: cfg.policy,
    providers: cfg.providers ?? [],
    gpu: cfg.gpu ?? false,
    autoProviders: cfg.autoProviders ?? true,
    remoteWorkspaceDir: normalizeRemotePath(cfg.remoteWorkspaceDir, DEFAULT_REMOTE_WORKSPACE_DIR),
    remoteAgentWorkspaceDir: normalizeRemotePath(
      cfg.remoteAgentWorkspaceDir,
      DEFAULT_REMOTE_AGENT_WORKSPACE_DIR,
    ),
    timeoutMs:
      typeof cfg.timeoutSeconds === "number"
        ? Math.floor(cfg.timeoutSeconds * 1000)
        : DEFAULT_TIMEOUT_MS,
  };
}
