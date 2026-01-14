import fs from "node:fs";
import path from "node:path";

import type { ClawdbotConfig } from "../config/config.js";
import { resolveBrewExecutable } from "../infra/brew.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { resolveUserPath } from "../utils.js";
import {
  hasBinary,
  loadWorkspaceSkillEntries,
  resolveSkillsInstallPreferences,
  type SkillEntry,
  type SkillInstallSpec,
  type SkillsInstallPreferences,
} from "./skills.js";

export type SkillInstallRequest = {
  workspaceDir: string;
  skillName: string;
  installId: string;
  timeoutMs?: number;
  config?: ClawdbotConfig;
};

export type SkillInstallResult = {
  ok: boolean;
  message: string;
  stdout: string;
  stderr: string;
  code: number | null;
};

function summarizeInstallOutput(text: string): string | undefined {
  const raw = text.trim();
  if (!raw) return undefined;
  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return undefined;

  const preferred =
    lines.find((line) => /^error\b/i.test(line)) ??
    lines.find((line) => /\b(err!|error:|failed)\b/i.test(line)) ??
    lines.at(-1);

  if (!preferred) return undefined;
  const normalized = preferred.replace(/\s+/g, " ").trim();
  const maxLen = 200;
  return normalized.length > maxLen ? `${normalized.slice(0, maxLen - 1)}…` : normalized;
}

function formatInstallFailureMessage(result: {
  code: number | null;
  stdout: string;
  stderr: string;
}): string {
  const code = typeof result.code === "number" ? `exit ${result.code}` : "unknown exit";
  const summary = summarizeInstallOutput(result.stderr) ?? summarizeInstallOutput(result.stdout);
  if (!summary) return `Install failed (${code})`;
  return `Install failed (${code}): ${summary}`;
}

function resolveInstallId(spec: SkillInstallSpec, index: number): string {
  return (spec.id ?? `${spec.kind}-${index}`).trim();
}

function findInstallSpec(entry: SkillEntry, installId: string): SkillInstallSpec | undefined {
  const specs = entry.clawdbot?.install ?? [];
  for (const [index, spec] of specs.entries()) {
    if (resolveInstallId(spec, index) === installId) return spec;
  }
  return undefined;
}

function buildNodeInstallCommand(packageName: string, prefs: SkillsInstallPreferences): string[] {
  switch (prefs.nodeManager) {
    case "pnpm":
      return ["pnpm", "add", "-g", packageName];
    case "yarn":
      return ["yarn", "global", "add", packageName];
    case "bun":
      return ["bun", "add", "-g", packageName];
    default:
      return ["npm", "install", "-g", packageName];
  }
}

function buildInstallCommand(
  spec: SkillInstallSpec,
  prefs: SkillsInstallPreferences,
): {
  argv: string[] | null;
  error?: string;
} {
  switch (spec.kind) {
    case "brew": {
      if (!spec.formula) return { argv: null, error: "missing brew formula" };
      return { argv: ["brew", "install", spec.formula] };
    }
    case "node": {
      if (!spec.package) return { argv: null, error: "missing node package" };
      return {
        argv: buildNodeInstallCommand(spec.package, prefs),
      };
    }
    case "go": {
      if (!spec.module) return { argv: null, error: "missing go module" };
      return { argv: ["go", "install", spec.module] };
    }
    case "uv": {
      if (!spec.package) return { argv: null, error: "missing uv package" };
      return { argv: ["uv", "tool", "install", spec.package] };
    }
    default:
      return { argv: null, error: "unsupported installer" };
  }
}

async function resolveBrewBinDir(timeoutMs: number, brewExe?: string): Promise<string | undefined> {
  const exe = brewExe ?? (hasBinary("brew") ? "brew" : resolveBrewExecutable());
  if (!exe) return undefined;

  const prefixResult = await runCommandWithTimeout([exe, "--prefix"], {
    timeoutMs: Math.min(timeoutMs, 30_000),
  });
  if (prefixResult.code === 0) {
    const prefix = prefixResult.stdout.trim();
    if (prefix) return path.join(prefix, "bin");
  }

  const envPrefix = process.env.HOMEBREW_PREFIX?.trim();
  if (envPrefix) return path.join(envPrefix, "bin");

  for (const candidate of ["/opt/homebrew/bin", "/usr/local/bin"]) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // ignore
    }
  }
  return undefined;
}

export async function installSkill(params: SkillInstallRequest): Promise<SkillInstallResult> {
  const timeoutMs = Math.min(Math.max(params.timeoutMs ?? 300_000, 1_000), 900_000);
  const workspaceDir = resolveUserPath(params.workspaceDir);
  const entries = loadWorkspaceSkillEntries(workspaceDir);
  const entry = entries.find((item) => item.skill.name === params.skillName);
  if (!entry) {
    return {
      ok: false,
      message: `Skill not found: ${params.skillName}`,
      stdout: "",
      stderr: "",
      code: null,
    };
  }

  const spec = findInstallSpec(entry, params.installId);
  if (!spec) {
    return {
      ok: false,
      message: `Installer not found: ${params.installId}`,
      stdout: "",
      stderr: "",
      code: null,
    };
  }

  const prefs = resolveSkillsInstallPreferences(params.config);
  const command = buildInstallCommand(spec, prefs);
  if (command.error) {
    return {
      ok: false,
      message: command.error,
      stdout: "",
      stderr: "",
      code: null,
    };
  }

  const brewExe = hasBinary("brew") ? "brew" : resolveBrewExecutable();
  if (spec.kind === "brew" && !brewExe) {
    return {
      ok: false,
      message: "brew not installed",
      stdout: "",
      stderr: "",
      code: null,
    };
  }
  if (spec.kind === "uv" && !hasBinary("uv")) {
    if (brewExe) {
      const brewResult = await runCommandWithTimeout([brewExe, "install", "uv"], {
        timeoutMs,
      });
      if (brewResult.code !== 0) {
        return {
          ok: false,
          message: "Failed to install uv (brew)",
          stdout: brewResult.stdout.trim(),
          stderr: brewResult.stderr.trim(),
          code: brewResult.code,
        };
      }
    } else {
      return {
        ok: false,
        message: "uv not installed (install via brew)",
        stdout: "",
        stderr: "",
        code: null,
      };
    }
  }
  if (!command.argv || command.argv.length === 0) {
    return {
      ok: false,
      message: "invalid install command",
      stdout: "",
      stderr: "",
      code: null,
    };
  }

  if (spec.kind === "brew" && brewExe && command.argv[0] === "brew") {
    command.argv[0] = brewExe;
  }

  if (spec.kind === "go" && !hasBinary("go")) {
    if (brewExe) {
      const brewResult = await runCommandWithTimeout([brewExe, "install", "go"], {
        timeoutMs,
      });
      if (brewResult.code !== 0) {
        return {
          ok: false,
          message: "Failed to install go (brew)",
          stdout: brewResult.stdout.trim(),
          stderr: brewResult.stderr.trim(),
          code: brewResult.code,
        };
      }
    } else {
      return {
        ok: false,
        message: "go not installed (install via brew)",
        stdout: "",
        stderr: "",
        code: null,
      };
    }
  }

  let env: NodeJS.ProcessEnv | undefined;
  if (spec.kind === "go" && brewExe) {
    const brewBin = await resolveBrewBinDir(timeoutMs, brewExe);
    if (brewBin) env = { GOBIN: brewBin };
  }

  const result = await (async () => {
    const argv = command.argv;
    if (!argv || argv.length === 0) {
      return { code: null, stdout: "", stderr: "invalid install command" };
    }
    try {
      return await runCommandWithTimeout(argv, {
        timeoutMs,
        env,
      });
    } catch (err) {
      const stderr = err instanceof Error ? err.message : String(err);
      return { code: null, stdout: "", stderr };
    }
  })();

  const success = result.code === 0;
  return {
    ok: success,
    message: success ? "Installed" : formatInstallFailureMessage(result),
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    code: result.code,
  };
}
