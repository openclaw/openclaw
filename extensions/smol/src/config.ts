import path from "node:path";
import { buildPluginConfigSchema, type OpenClawPluginConfigSchema } from "openclaw/plugin-sdk/core";
import {
  formatPluginConfigIssue,
  mapPluginConfigIssues,
} from "openclaw/plugin-sdk/extension-shared";
import { MAX_TIMER_TIMEOUT_SECONDS } from "openclaw/plugin-sdk/number-runtime";
import { z } from "zod";

export type ResolvedSmolPluginConfig = ReturnType<typeof resolveSmolPluginConfig>;

const DEFAULT_COMMAND = "smol";
/** Debian-based: the file tools need GNU coreutils and python3 inside the machine. */
const DEFAULT_IMAGE = "python:3.12-slim";
const DEFAULT_CPUS = 2;
const DEFAULT_MEMORY_MB = 2048;
/** 1 TiB: well past any host the engine runs on, so a typo in GiB vs MiB still fails loudly. */
const MAX_MEMORY_MB = 1_048_576;
const DEFAULT_TIMEOUT_MS = 120_000;

const nonEmptyTrimmedString = (message: string) =>
  z.string({ error: message }).trim().min(1, { error: message });

const SmolPluginConfigSchema = z.strictObject({
  command: nonEmptyTrimmedString("command must be a non-empty string").optional(),
  image: nonEmptyTrimmedString("image must be a non-empty string").optional(),
  cpus: z
    .number({ error: "cpus must be an integer between 1 and 64" })
    .int({ error: "cpus must be an integer between 1 and 64" })
    .min(1, { error: "cpus must be an integer >= 1" })
    .max(64, { error: "cpus must be an integer <= 64" })
    .optional(),
  memoryMb: z
    .number({ error: "memoryMb must be an integer >= 256" })
    .int({ error: "memoryMb must be an integer >= 256" })
    .min(256, { error: "memoryMb must be an integer >= 256" })
    .max(MAX_MEMORY_MB, { error: `memoryMb must be an integer <= ${MAX_MEMORY_MB}` })
    .optional(),
  workdir: nonEmptyTrimmedString("workdir must be a non-empty string")
    .regex(/^\//u, { error: "smol workdir must be an absolute path inside the machine" })
    .optional(),
  branchable: z.boolean({ error: "branchable must be a boolean" }).optional(),
  timeoutSeconds: z
    .number({
      error: `timeoutSeconds must be a number between 1 and ${MAX_TIMER_TIMEOUT_SECONDS}`,
    })
    .min(1, { error: "timeoutSeconds must be a number >= 1" })
    .max(MAX_TIMER_TIMEOUT_SECONDS, {
      error: `timeoutSeconds must be a number <= ${MAX_TIMER_TIMEOUT_SECONDS}`,
    })
    .optional(),
});

export function createSmolPluginConfigSchema(): OpenClawPluginConfigSchema {
  return buildPluginConfigSchema(SmolPluginConfigSchema, {
    safeParse(value) {
      if (value === undefined) {
        return { success: true, data: undefined };
      }
      const parsed = SmolPluginConfigSchema.safeParse(value);
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

export function resolveSmolPluginConfig(value: unknown) {
  const parsed = SmolPluginConfigSchema.safeParse(value === undefined ? {} : value);
  if (!parsed.success) {
    const message = formatPluginConfigIssue(parsed.error.issues[0]);
    throw new Error(`Invalid smol plugin config: ${message}`);
  }
  const cfg = parsed.data;
  return {
    command: cfg.command ?? DEFAULT_COMMAND,
    image: cfg.image ?? DEFAULT_IMAGE,
    cpus: cfg.cpus ?? DEFAULT_CPUS,
    memoryMb: cfg.memoryMb ?? DEFAULT_MEMORY_MB,
    workdir: cfg.workdir ? path.posix.normalize(cfg.workdir) : undefined,
    branchable: cfg.branchable ?? true,
    timeoutMs: cfg.timeoutSeconds === undefined ? DEFAULT_TIMEOUT_MS : cfg.timeoutSeconds * 1000,
  };
}
