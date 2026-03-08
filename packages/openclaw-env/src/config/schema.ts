import { z } from "zod";

export const OPENCLAW_ENV_SCHEMA_VERSION = "openclaw_env.v1" as const;

export const MountModeSchema = z.enum(["ro", "rw"]);
export type MountMode = z.infer<typeof MountModeSchema>;

export const NetworkModeSchema = z.enum(["off", "full", "restricted"]);
export type NetworkMode = z.infer<typeof NetworkModeSchema>;

export const SecretsModeSchema = z.enum(["none", "env_file", "docker_secrets"]);
export type SecretsMode = z.infer<typeof SecretsModeSchema>;

export const OpenClawSectionSchema = z.object({
  image: z.string().min(1).default("openclaw:local"),
  command: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).default({}),
});

function isValidWorkspaceSubpath(raw: string): boolean {
  const normalized = raw.trim().replace(/\\/g, "/");
  if (!normalized || normalized === "." || normalized === "..") {
    return false;
  }
  if (normalized.startsWith("/") || /^[a-zA-Z]:\//.test(normalized)) {
    return false;
  }
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length === 0) {
    return false;
  }
  return parts.every((part) => part !== "." && part !== "..");
}

export const WorkspaceSubpathSchema = z
  .string()
  .min(1)
  .refine(isValidWorkspaceSubpath, "must be a relative subpath under workspace");

export const WorkspaceSectionSchema = z.object({
  path: z.string().min(1).default("."),
  mode: MountModeSchema.default("ro"),
  write_allowlist: z.array(WorkspaceSubpathSchema).default([]),
});

export const ExtraMountSchema = z.object({
  host: z.string().min(1),
  container: z.string().min(1),
  mode: MountModeSchema.default("ro"),
});

export const NetworkRestrictedSchema = z.object({
  allowlist: z.array(z.string().min(1)).default([]),
});

export const NetworkSectionSchema = z.object({
  mode: NetworkModeSchema.default("off"),
  restricted: NetworkRestrictedSchema.default({ allowlist: [] }),
});

export const DockerSecretSchema = z.object({
  name: z.string().min(1),
  file: z.string().min(1),
});

export const SecretsSectionSchema = z.object({
  mode: SecretsModeSchema.default("none"),
  env_file: z.string().min(1).default(".env.openclaw"),
  docker_secrets: z.array(DockerSecretSchema).default([]),
});

export const LimitsSectionSchema = z.object({
  cpus: z.number().positive().default(2),
  memory: z.string().min(1).default("4g"),
  pids: z.number().int().positive().default(256),
});

export const RuntimeSectionSchema = z.object({
  user: z.string().min(1).default("1000:1000"),
});

export const WriteGuardsSectionSchema = z.object({
  enabled: z.boolean().default(false),
  max_file_writes: z.number().int().positive().optional(),
  max_bytes_written: z.number().int().positive().optional(),
  dry_run_audit: z.boolean().default(false),
  poll_interval_ms: z.number().int().min(250).max(60_000).default(2000),
});

export const OpenClawEnvConfigSchema = z
  .object({
    schema_version: z.literal(OPENCLAW_ENV_SCHEMA_VERSION),
    openclaw: OpenClawSectionSchema.default({ image: "openclaw:local", env: {} }),
    workspace: WorkspaceSectionSchema.default({ path: ".", mode: "ro", write_allowlist: [] }),
    mounts: z.array(ExtraMountSchema).default([]),
    network: NetworkSectionSchema.default({ mode: "off", restricted: { allowlist: [] } }),
    secrets: SecretsSectionSchema.default({
      mode: "none",
      env_file: ".env.openclaw",
      docker_secrets: [],
    }),
    limits: LimitsSectionSchema.default({ cpus: 2, memory: "4g", pids: 256 }),
    runtime: RuntimeSectionSchema.default({ user: "1000:1000" }),
    write_guards: WriteGuardsSectionSchema.default({
      enabled: false,
      dry_run_audit: false,
      poll_interval_ms: 2000,
    }),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.workspace.mode === "rw" && cfg.workspace.write_allowlist.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["workspace", "write_allowlist"],
        message: "requires workspace.mode=ro to enforce subpath write boundaries",
      });
    }
  })
  .strict();

export type OpenClawEnvConfig = z.infer<typeof OpenClawEnvConfigSchema>;
