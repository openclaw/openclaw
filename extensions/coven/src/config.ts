import os from "node:os";
import path from "node:path";
import { buildPluginConfigSchema } from "openclaw/plugin-sdk/core";
import { z } from "openclaw/plugin-sdk/zod";

export type CovenPluginConfig = {
  covenHome?: string;
  socketPath?: string;
  fallbackBackend?: string;
  pollIntervalMs?: number;
  harnesses?: Record<string, string>;
};

export type ResolvedCovenPluginConfig = {
  covenHome: string;
  socketPath: string;
  fallbackBackend: string;
  pollIntervalMs: number;
  harnesses: Record<string, string>;
};

const DEFAULT_FALLBACK_BACKEND = "acpx";
const DEFAULT_POLL_INTERVAL_MS = 250;

const nonEmptyString = z.string().trim().min(1);

export const CovenPluginConfigSchema = z.strictObject({
  covenHome: nonEmptyString.optional(),
  socketPath: nonEmptyString.optional(),
  fallbackBackend: nonEmptyString.optional(),
  pollIntervalMs: z.number().min(25).max(10_000).optional(),
  harnesses: z.record(z.string(), nonEmptyString).optional(),
});

export function createCovenPluginConfigSchema() {
  return buildPluginConfigSchema(CovenPluginConfigSchema);
}

function normalizeBackendId(value: string | undefined): string {
  const normalized = value?.trim().toLowerCase();
  return normalized || DEFAULT_FALLBACK_BACKEND;
}

function resolveCovenHome(raw: string | undefined): string {
  const fromConfig = raw?.trim();
  if (fromConfig) {
    return path.resolve(fromConfig);
  }
  const fromEnv = process.env.COVEN_HOME?.trim();
  if (fromEnv) {
    return path.resolve(fromEnv);
  }
  return path.join(os.homedir(), ".coven");
}

function normalizeHarnesses(value: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(
    Object.entries(value ?? {}).flatMap(([agent, harness]) => {
      const normalizedAgent = agent.trim().toLowerCase();
      const normalizedHarness = harness.trim();
      return normalizedAgent && normalizedHarness ? [[normalizedAgent, normalizedHarness]] : [];
    }),
  );
}

export function resolveCovenPluginConfig(params: {
  rawConfig: unknown;
  workspaceDir?: string;
}): ResolvedCovenPluginConfig {
  const parsed = CovenPluginConfigSchema.safeParse(params.rawConfig ?? {});
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? "invalid Coven plugin config");
  }
  const config = parsed.data as CovenPluginConfig;
  const covenHome = resolveCovenHome(config.covenHome);
  return {
    covenHome,
    socketPath: path.resolve(config.socketPath?.trim() || path.join(covenHome, "coven.sock")),
    fallbackBackend: normalizeBackendId(config.fallbackBackend),
    pollIntervalMs: config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    harnesses: normalizeHarnesses(config.harnesses),
  };
}
