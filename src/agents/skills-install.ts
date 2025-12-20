import type { ClawdisConfig } from "../config/config.js";
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
  config?: ClawdisConfig;
};

export type SkillInstallResult = {
  ok: boolean;
  message: string;
  stdout: string;
  stderr: string;
  code: number | null;
};

function resolveInstallId(spec: SkillInstallSpec, index: number): string {
  return (spec.id ?? `${spec.kind}-${index}`).trim();
}

function findInstallSpec(
  entry: SkillEntry,
  installId: string,
): SkillInstallSpec | undefined {
  const specs = entry.clawdis?.install ?? [];
  for (const [index, spec] of specs.entries()) {
    if (resolveInstallId(spec, index) === installId) return spec;
  }
  return undefined;
}

function buildNodeInstallCommand(
  packageName: string,
  prefs: SkillsInstallPreferences,
): string[] {
  switch (prefs.nodeManager) {
    case "pnpm":
      return ["pnpm", "add", "-g", packageName];
    case "yarn":
      return ["yarn", "global", "add", packageName];
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
      if (!spec.formula)
        return { argv: null, error: "missing brew formula" };
      return { argv: ["brew", "install", spec.formula] };
    }
    case "node": {
      if (!spec.package)
        return { argv: null, error: "missing node package" };
      return {
        argv: buildNodeInstallCommand(spec.package, prefs),
      };
    }
    case "go": {
      if (!spec.module)
        return { argv: null, error: "missing go module" };
      return { argv: ["go", "install", spec.module] };
    }
    case "uv": {
      if (!spec.package)
        return { argv: null, error: "missing uv package" };
      return { argv: ["uv", "tool", "install", spec.package] };
    }
    default:
      return { argv: null, error: "unsupported installer" };
  }
}

export async function installSkill(
  params: SkillInstallRequest,
): Promise<SkillInstallResult> {
  const timeoutMs = Math.min(
    Math.max(params.timeoutMs ?? 300_000, 1_000),
    900_000,
  );
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
  if (spec.kind === "uv" && !hasBinary("uv")) {
    if (hasBinary("brew")) {
      const brewResult = await runCommandWithTimeout(
        ["brew", "install", "uv"],
        {
          timeoutMs,
        },
      );
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

  const result = await (async () => {
    const argv = command.argv;
    if (!argv || argv.length === 0) {
      return { code: null, stdout: "", stderr: "invalid install command" };
    }
    return runCommandWithTimeout(argv, {
      timeoutMs,
    });
  })();

  const success = result.code === 0;
  return {
    ok: success,
    message: success ? "Installed" : "Install failed",
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    code: result.code,
  };
}
