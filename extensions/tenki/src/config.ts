// Tenki plugin config schema and resolution.
import path from "node:path";
import { buildPluginConfigSchema, type OpenClawPluginConfigSchema } from "openclaw/plugin-sdk/core";
import {
  formatPluginConfigIssue,
  mapPluginConfigIssues,
} from "openclaw/plugin-sdk/extension-shared";
import { z } from "zod";

type TenkiPluginConfig = {
  authToken?: string;
  baseUrl?: string;
  projectId?: string;
  workspaceId?: string;
  image?: string;
  workspaceRoot?: string;
  idleTimeoutMinutes?: number;
  cpuCores?: number;
  memoryMb?: number;
  diskSizeGb?: number;
  tags?: string[];
};

export type ResolvedTenkiPluginConfig = {
  authToken?: string;
  baseUrl?: string;
  projectId?: string;
  workspaceId?: string;
  image?: string;
  workspaceRoot: string;
  idleTimeoutMinutes?: number;
  cpuCores?: number;
  memoryMb?: number;
  diskSizeGb?: number;
  tags: string[];
};

const DEFAULT_WORKSPACE_ROOT = "/tmp/openclaw-sandboxes";

const nonEmptyTrimmedString = (message: string) =>
  z.string({ error: message }).trim().min(1, { error: message });

const positiveNumber = (field: string) =>
  z.number({ error: `${field} must be a number >= 1` }).min(1, {
    error: `${field} must be a number >= 1`,
  });

const TenkiPluginConfigSchema = z.strictObject({
  authToken: nonEmptyTrimmedString("authToken must be a non-empty string").optional(),
  baseUrl: nonEmptyTrimmedString("baseUrl must be a non-empty string").optional(),
  projectId: nonEmptyTrimmedString("projectId must be a non-empty string").optional(),
  workspaceId: nonEmptyTrimmedString("workspaceId must be a non-empty string").optional(),
  image: nonEmptyTrimmedString("image must be a non-empty string").optional(),
  workspaceRoot: nonEmptyTrimmedString("workspaceRoot must be a non-empty string").optional(),
  idleTimeoutMinutes: positiveNumber("idleTimeoutMinutes").optional(),
  cpuCores: positiveNumber("cpuCores").optional(),
  memoryMb: positiveNumber("memoryMb").optional(),
  diskSizeGb: positiveNumber("diskSizeGb").optional(),
  tags: z
    .array(
      z.string({ error: "tags must be an array of strings" }).trim().min(1, {
        error: "tags must be an array of strings",
      }),
      { error: "tags must be an array of strings" },
    )
    .optional(),
});

function normalizeWorkspaceRoot(value: string | undefined): string {
  const candidate = value ?? DEFAULT_WORKSPACE_ROOT;
  const normalized = path.posix.normalize(candidate.trim().replaceAll("\\", "/"));
  if (!normalized.startsWith("/")) {
    throw new Error(`Tenki workspaceRoot must be an absolute POSIX path: ${candidate}`);
  }
  return normalized === "/" ? normalized : normalized.replace(/\/+$/g, "");
}

export function createTenkiPluginConfigSchema(): OpenClawPluginConfigSchema {
  return buildPluginConfigSchema(TenkiPluginConfigSchema, {
    safeParse(value) {
      if (value === undefined) {
        return { success: true, data: undefined };
      }
      const parsed = TenkiPluginConfigSchema.safeParse(value);
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

export function resolveTenkiPluginConfig(value: unknown): ResolvedTenkiPluginConfig {
  if (value === undefined) {
    return {
      workspaceRoot: DEFAULT_WORKSPACE_ROOT,
      tags: [],
    };
  }
  const parsed = TenkiPluginConfigSchema.safeParse(value);
  if (!parsed.success) {
    const message = formatPluginConfigIssue(parsed.error.issues[0]);
    throw new Error(`Invalid tenki plugin config: ${message}`);
  }
  const cfg = parsed.data as TenkiPluginConfig;
  return {
    authToken: cfg.authToken,
    baseUrl: cfg.baseUrl,
    projectId: cfg.projectId,
    workspaceId: cfg.workspaceId,
    image: cfg.image,
    workspaceRoot: normalizeWorkspaceRoot(cfg.workspaceRoot),
    idleTimeoutMinutes: cfg.idleTimeoutMinutes,
    cpuCores: cfg.cpuCores,
    memoryMb: cfg.memoryMb,
    diskSizeGb: cfg.diskSizeGb,
    tags: cfg.tags ?? [],
  };
}
