import { hashTextSha256 } from "./hash.js";
import type { SandboxBrowserConfig, SandboxDockerConfig, SandboxWorkspaceAccess } from "./types.js";

type SandboxHashInput = {
  docker: SandboxDockerConfig;
  workspaceAccess: SandboxWorkspaceAccess;
  workspaceDir: string;
  agentWorkspaceDir: string;
};

type SandboxBrowserHashInput = {
  docker: SandboxDockerConfig;
  browser: Pick<
    SandboxBrowserConfig,
    "cdpPort" | "vncPort" | "noVncPort" | "headless" | "enableNoVnc"
  >;
  workspaceAccess: SandboxWorkspaceAccess;
  workspaceDir: string;
  agentWorkspaceDir: string;
};

function normalizeForHash(value: unknown): unknown {
  if (value === undefined) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value.map(normalizeForHash).filter((item): item is unknown => item !== undefined);
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value).toSorted(([a], [b]) => a.localeCompare(b));
    const normalized: Record<string, unknown> = {};
    for (const [key, entryValue] of entries) {
      const next = normalizeForHash(entryValue);
      if (next !== undefined) {
        normalized[key] = next;
      }
    }
    return normalized;
  }
  return value;
}

export function computeSandboxConfigHash(input: SandboxHashInput): string {
  return computeHash(input);
}

export function computeSandboxBrowserConfigHash(input: SandboxBrowserHashInput): string {
  return computeHash(input);
}

function computeHash(input: unknown): string {
  const payload = normalizeForHash(input);
  const raw = JSON.stringify(payload);
  return hashTextSha256(raw);
}
