import os from "node:os";
import path from "node:path";
import { buildPluginConfigSchema } from "openclaw/plugin-sdk/core";
import { z } from "openclaw/plugin-sdk/zod";
import { lstatIfExists, pathIsInside, realpathIfExists } from "./path-utils.js";

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
  workspaceDir: string;
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

function expandTilde(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "~") {
    return os.homedir();
  }
  if (trimmed.startsWith("~/")) {
    return path.join(os.homedir(), trimmed.slice(2));
  }
  return trimmed;
}

function resolveConfiguredPath(raw: string, label: "covenHome" | "socketPath"): string {
  const expanded = expandTilde(raw);
  if (!path.isAbsolute(expanded)) {
    throw new Error(`Coven ${label} must be absolute`);
  }
  return path.resolve(expanded);
}

function resolveCovenHome(raw: string | undefined): string {
  const fromConfig = raw?.trim();
  if (fromConfig) {
    return resolveConfiguredPath(fromConfig, "covenHome");
  }
  const fromEnv = process.env.COVEN_HOME?.trim();
  if (fromEnv) {
    return resolveConfiguredPath(fromEnv, "covenHome");
  }
  return path.join(os.homedir(), ".coven");
}

function resolveSocketPath(covenHome: string, raw: string | undefined): string {
  if (lstatIfExists(covenHome)?.isSymbolicLink()) {
    throw new Error("Coven covenHome must not be a symlink");
  }
  const socketPath = raw?.trim()
    ? resolveConfiguredPath(raw, "socketPath")
    : path.join(covenHome, "coven.sock");
  if (!pathIsInside(covenHome, socketPath)) {
    throw new Error("Coven socketPath must stay inside covenHome");
  }
  const socketStat = lstatIfExists(socketPath);
  if (socketStat?.isSymbolicLink()) {
    throw new Error("Coven socketPath must not be a symlink");
  }
  const realCovenHome = realpathIfExists(covenHome);
  const realSocketDir = realpathIfExists(path.dirname(socketPath));
  if (realCovenHome && realSocketDir && !pathIsInside(realCovenHome, realSocketDir)) {
    throw new Error("Coven socketPath must stay inside covenHome");
  }
  const realSocketPath = realpathIfExists(socketPath);
  if (realCovenHome && realSocketPath && !pathIsInside(realCovenHome, realSocketPath)) {
    throw new Error("Coven socketPath must stay inside covenHome");
  }
  return socketPath;
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
  const workspaceDir = path.resolve(params.workspaceDir ?? process.cwd());
  const covenHome = resolveCovenHome(config.covenHome);
  return {
    covenHome,
    socketPath: resolveSocketPath(covenHome, config.socketPath),
    workspaceDir,
    fallbackBackend: normalizeBackendId(config.fallbackBackend),
    pollIntervalMs: config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    harnesses: normalizeHarnesses(config.harnesses),
  };
}

export const __testing = {
  expandTilde,
  resolveConfiguredPath,
};
