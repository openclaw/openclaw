import { runCommandWithTimeout } from "../process/exec.js";
import { resolveUserPath } from "../utils.js";
import {
  loadWorkspaceSkillEntries,
  type SkillEntry,
  type SkillInstallSpec,
} from "./skills.js";

export type SkillInstallRequest = {
  workspaceDir: string;
  skillName: string;
  installId: string;
  timeoutMs?: number;
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

function runShell(command: string, timeoutMs: number) {
  return runCommandWithTimeout(["/bin/zsh", "-lc", command], { timeoutMs });
}

function buildInstallCommand(spec: SkillInstallSpec): {
  argv: string[] | null;
  shell: string | null;
  cwd?: string;
  error?: string;
} {
  switch (spec.kind) {
    case "brew": {
      if (!spec.formula) return { argv: null, shell: null, error: "missing brew formula" };
      return { argv: ["brew", "install", spec.formula], shell: null };
    }
    case "node": {
      if (!spec.package) return { argv: null, shell: null, error: "missing node package" };
      return { argv: ["npm", "install", "-g", spec.package], shell: null };
    }
    case "go": {
      if (!spec.module) return { argv: null, shell: null, error: "missing go module" };
      return { argv: ["go", "install", spec.module], shell: null };
    }
    case "pnpm": {
      if (!spec.repoPath || !spec.script) {
        return { argv: null, shell: null, error: "missing pnpm repoPath/script" };
      }
      const repoPath = resolveUserPath(spec.repoPath);
      const cmd = `cd ${JSON.stringify(repoPath)} && pnpm install && pnpm run ${JSON.stringify(spec.script)}`;
      return { argv: null, shell: cmd };
    }
    case "git": {
      if (!spec.url || !spec.destination) {
        return { argv: null, shell: null, error: "missing git url/destination" };
      }
      const dest = resolveUserPath(spec.destination);
      const cmd = `if [ -d ${JSON.stringify(dest)} ]; then echo "Already cloned"; else git clone ${JSON.stringify(spec.url)} ${JSON.stringify(dest)}; fi`;
      return { argv: null, shell: cmd };
    }
    case "shell": {
      if (!spec.command) return { argv: null, shell: null, error: "missing shell command" };
      return { argv: null, shell: spec.command };
    }
    default:
      return { argv: null, shell: null, error: "unsupported installer" };
  }
}

export async function installSkill(
  params: SkillInstallRequest,
): Promise<SkillInstallResult> {
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

  const command = buildInstallCommand(spec);
  if (command.error) {
    return {
      ok: false,
      message: command.error,
      stdout: "",
      stderr: "",
      code: null,
    };
  }
  if (!command.shell && (!command.argv || command.argv.length === 0)) {
    return {
      ok: false,
      message: "invalid install command",
      stdout: "",
      stderr: "",
      code: null,
    };
  }

  const result = command.shell
    ? await runShell(command.shell, timeoutMs)
    : await runCommandWithTimeout(command.argv, { timeoutMs, cwd: command.cwd });

  const success = result.code === 0;
  return {
    ok: success,
    message: success ? "Installed" : "Install failed",
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    code: result.code,
  };
}
