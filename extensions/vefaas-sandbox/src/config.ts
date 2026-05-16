import path from "node:path";
import { buildPluginConfigSchema, type OpenClawPluginConfigSchema } from "openclaw/plugin-sdk/core";
import {
  formatPluginConfigIssue,
  mapPluginConfigIssues,
} from "openclaw/plugin-sdk/extension-shared";
import { z } from "zod";

type VefaasResourcesConfig = {
  cpuCores?: number;
  memoryMiB?: number;
  gpuCount?: number;
  gpuType?: string;
};

type VefaasNetworkConfig = {
  egress?: "default" | "restricted" | "disabled";
  vpcId?: string;
  subnetId?: string;
  securityGroupId?: string;
};

export type VefaasOpenCodeConfig = {
  entrypoint?: string;
  eventMode?: "ndjson";
  artifactDir?: string;
  acp?: boolean;
  env?: Record<string, string>;
};

type VefaasPluginConfig = {
  mode?: "remote";
  command?: string;
  functionId?: string;
  region?: string;
  endpoint?: string;
  image?: string;
  remoteWorkspaceDir?: string;
  remoteAgentWorkspaceDir?: string;
  ttlSeconds?: number;
  timeoutSeconds?: number;
  resources?: VefaasResourcesConfig;
  network?: VefaasNetworkConfig;
  opencode?: VefaasOpenCodeConfig;
};

export type ResolvedVefaasPluginConfig = {
  mode: "remote";
  command: string;
  functionId?: string;
  region?: string;
  endpoint?: string;
  image: string;
  remoteWorkspaceDir: string;
  remoteAgentWorkspaceDir: string;
  ttlSeconds: number;
  timeoutMs: number;
  resources?: VefaasResourcesConfig;
  network?: VefaasNetworkConfig;
  opencode: Required<VefaasOpenCodeConfig>;
};

export type VefaasSandboxCreateSpec = {
  backend: "vefaas";
  mode: "remote";
  functionId?: string;
  region?: string;
  endpoint?: string;
  image: string;
  remoteWorkspaceDir: string;
  remoteAgentWorkspaceDir: string;
  ttlSeconds: number;
  resources?: VefaasResourcesConfig;
  network?: VefaasNetworkConfig;
  opencode: Required<VefaasOpenCodeConfig>;
};

const DEFAULT_COMMAND = "openclaw-vefaas-sandbox";
const DEFAULT_IMAGE =
  "enterprise-public-cn-beijing.cr.volces.com/vefaas-public/all-in-one-sandbox:1.9.3";
const DEFAULT_REMOTE_WORKSPACE_DIR = "/workspace";
const DEFAULT_REMOTE_AGENT_WORKSPACE_DIR = "/agent";
const DEFAULT_TTL_SECONDS = 3600;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_OPENCODE_ENTRYPOINT = "opencode";
const DEFAULT_OPENCODE_EVENT_MODE = "ndjson";
const DEFAULT_OPENCODE_ARTIFACT_DIR = "/workspace/.openclaw-artifacts";

const nonEmptyTrimmedString = (message: string) =>
  z.string({ error: message }).trim().min(1, { error: message });

const resourcesSchema = z.strictObject({
  cpuCores: z
    .number({ error: "resources.cpuCores must be a number >= 0.1" })
    .min(0.1, { error: "resources.cpuCores must be a number >= 0.1" })
    .optional(),
  memoryMiB: z
    .number({ error: "resources.memoryMiB must be a number >= 128" })
    .int({ error: "resources.memoryMiB must be an integer >= 128" })
    .min(128, { error: "resources.memoryMiB must be an integer >= 128" })
    .optional(),
  gpuCount: z
    .number({ error: "resources.gpuCount must be an integer >= 0" })
    .int({ error: "resources.gpuCount must be an integer >= 0" })
    .min(0, { error: "resources.gpuCount must be an integer >= 0" })
    .optional(),
  gpuType: nonEmptyTrimmedString("resources.gpuType must be a non-empty string").optional(),
});

const networkSchema = z.strictObject({
  egress: z
    .enum(["default", "restricted", "disabled"], {
      error: "network.egress must be one of default, restricted, disabled",
    })
    .optional(),
  vpcId: nonEmptyTrimmedString("network.vpcId must be a non-empty string").optional(),
  subnetId: nonEmptyTrimmedString("network.subnetId must be a non-empty string").optional(),
  securityGroupId: nonEmptyTrimmedString(
    "network.securityGroupId must be a non-empty string",
  ).optional(),
});

const opencodeSchema = z.strictObject({
  entrypoint: nonEmptyTrimmedString("opencode.entrypoint must be a non-empty string").optional(),
  eventMode: z.literal("ndjson", { error: "opencode.eventMode must be ndjson" }).optional(),
  artifactDir: nonEmptyTrimmedString("opencode.artifactDir must be a non-empty string").optional(),
  acp: z.boolean({ error: "opencode.acp must be a boolean" }).optional(),
  env: z.record(z.string(), z.string()).optional(),
});

const VefaasPluginConfigSchema = z.strictObject({
  mode: z.literal("remote", { error: "mode must be remote" }).optional(),
  command: nonEmptyTrimmedString("command must be a non-empty string").optional(),
  functionId: nonEmptyTrimmedString("functionId must be a non-empty string").optional(),
  region: nonEmptyTrimmedString("region must be a non-empty string").optional(),
  endpoint: nonEmptyTrimmedString("endpoint must be a non-empty string").optional(),
  image: nonEmptyTrimmedString("image must be a non-empty string").optional(),
  remoteWorkspaceDir: nonEmptyTrimmedString(
    "remoteWorkspaceDir must be a non-empty string",
  ).optional(),
  remoteAgentWorkspaceDir: nonEmptyTrimmedString(
    "remoteAgentWorkspaceDir must be a non-empty string",
  ).optional(),
  ttlSeconds: z
    .number({ error: "ttlSeconds must be a number >= 60" })
    .int({ error: "ttlSeconds must be an integer >= 60" })
    .min(60, { error: "ttlSeconds must be an integer >= 60" })
    .optional(),
  timeoutSeconds: z
    .number({ error: "timeoutSeconds must be a number >= 1" })
    .min(1, { error: "timeoutSeconds must be a number >= 1" })
    .optional(),
  resources: resourcesSchema.optional(),
  network: networkSchema.optional(),
  opencode: opencodeSchema.optional(),
});

function normalizeRemotePath(
  value: string | undefined,
  fallback: string,
  fieldName: string,
): string {
  const candidate = value ?? fallback;
  const normalized = path.posix.normalize(candidate.trim() || fallback);
  if (!normalized.startsWith("/")) {
    throw new Error(`VEFaaS ${fieldName} must be absolute: ${candidate}`);
  }
  if (normalized === "/") {
    throw new Error(`VEFaaS ${fieldName} must not be the filesystem root.`);
  }
  return normalized;
}

function trimOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function createVefaasPluginConfigSchema(): OpenClawPluginConfigSchema {
  return buildPluginConfigSchema(VefaasPluginConfigSchema, {
    safeParse(value) {
      if (value === undefined) {
        return { success: true, data: undefined };
      }
      const parsed = VefaasPluginConfigSchema.safeParse(value);
      if (parsed.success) {
        return { success: true, data: parsed.data };
      }
      return {
        success: false,
        error: {
          issues: mapPluginConfigIssues(parsed.error.issues),
        },
      };
    },
  });
}

export function resolveVefaasPluginConfig(value: unknown): ResolvedVefaasPluginConfig {
  if (value === undefined) {
    return {
      mode: "remote",
      command: DEFAULT_COMMAND,
      functionId: undefined,
      region: undefined,
      endpoint: undefined,
      image: DEFAULT_IMAGE,
      remoteWorkspaceDir: DEFAULT_REMOTE_WORKSPACE_DIR,
      remoteAgentWorkspaceDir: DEFAULT_REMOTE_AGENT_WORKSPACE_DIR,
      ttlSeconds: DEFAULT_TTL_SECONDS,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      resources: undefined,
      network: undefined,
      opencode: {
        entrypoint: DEFAULT_OPENCODE_ENTRYPOINT,
        eventMode: DEFAULT_OPENCODE_EVENT_MODE,
        artifactDir: DEFAULT_OPENCODE_ARTIFACT_DIR,
        acp: false,
        env: {},
      },
    };
  }

  const parsed = VefaasPluginConfigSchema.safeParse(value);
  if (!parsed.success) {
    const message = formatPluginConfigIssue(parsed.error.issues[0]);
    throw new Error(`Invalid vefaas-sandbox plugin config: ${message}`);
  }
  const cfg = parsed.data as VefaasPluginConfig;
  return {
    mode: "remote",
    command: cfg.command ?? DEFAULT_COMMAND,
    functionId: trimOptional(cfg.functionId),
    region: trimOptional(cfg.region),
    endpoint: trimOptional(cfg.endpoint),
    image: cfg.image ?? DEFAULT_IMAGE,
    remoteWorkspaceDir: normalizeRemotePath(
      cfg.remoteWorkspaceDir,
      DEFAULT_REMOTE_WORKSPACE_DIR,
      "remoteWorkspaceDir",
    ),
    remoteAgentWorkspaceDir: normalizeRemotePath(
      cfg.remoteAgentWorkspaceDir,
      DEFAULT_REMOTE_AGENT_WORKSPACE_DIR,
      "remoteAgentWorkspaceDir",
    ),
    ttlSeconds: cfg.ttlSeconds ?? DEFAULT_TTL_SECONDS,
    timeoutMs:
      typeof cfg.timeoutSeconds === "number"
        ? Math.floor(cfg.timeoutSeconds * 1000)
        : DEFAULT_TIMEOUT_MS,
    resources: cfg.resources,
    network: cfg.network,
    opencode: {
      entrypoint: cfg.opencode?.entrypoint ?? DEFAULT_OPENCODE_ENTRYPOINT,
      eventMode: cfg.opencode?.eventMode ?? DEFAULT_OPENCODE_EVENT_MODE,
      artifactDir: normalizeRemotePath(
        cfg.opencode?.artifactDir,
        DEFAULT_OPENCODE_ARTIFACT_DIR,
        "opencode.artifactDir",
      ),
      acp: cfg.opencode?.acp === true,
      env: cfg.opencode?.env ?? {},
    },
  };
}

export function buildVefaasSandboxCreateSpec(
  config: ResolvedVefaasPluginConfig,
): VefaasSandboxCreateSpec {
  return {
    backend: "vefaas",
    mode: config.mode,
    functionId: config.functionId,
    region: config.region,
    endpoint: config.endpoint,
    image: config.image,
    remoteWorkspaceDir: config.remoteWorkspaceDir,
    remoteAgentWorkspaceDir: config.remoteAgentWorkspaceDir,
    ttlSeconds: config.ttlSeconds,
    resources: config.resources,
    network: config.network,
    opencode: config.opencode,
  };
}
