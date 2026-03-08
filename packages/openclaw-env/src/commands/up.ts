import fs from "node:fs/promises";
import path from "node:path";
import { loadOpenClawEnvConfig } from "../config/load.js";
import { generateCompose } from "../generator/compose.js";
import { evaluateSafety } from "../security/warnings.js";
import { runDockerCompose } from "../utils/docker.js";
import { promptConfirm } from "../utils/prompt.js";
import { formatPermissionSummary } from "./summary.js";

export type UpCommandOptions = {
  cwd: string;
  configPath?: string;
  yes: boolean;
  attach: boolean;
  iKnowWhatImDoing: boolean;
  acceptRisk: boolean;
};

function formatFindings(findings: ReturnType<typeof evaluateSafety>): string {
  const all = findings.findings;
  if (all.length === 0) {
    return "";
  }
  const lines: string[] = [];
  lines.push("");
  lines.push("Safety notes");
  for (const f of all) {
    const prefix =
      f.kind === "hard_error" ? "ERROR" : f.kind === "requires_override" ? "GATED" : "WARN";
    lines.push(`- ${prefix}: ${f.message}`);
    if (f.details && f.details.length > 0) {
      for (const d of f.details) {
        lines.push(`  ${d}`);
      }
    }
  }
  return lines.join("\n");
}

async function confirmProceed(message: string): Promise<boolean> {
  return promptConfirm({ message, defaultValue: false });
}

async function writeGeneratedFiles(
  cfg: Awaited<ReturnType<typeof loadOpenClawEnvConfig>>,
  artifacts: ReturnType<typeof generateCompose>,
): Promise<void> {
  await fs.mkdir(cfg.outputDir, { recursive: true });
  await fs.writeFile(cfg.generated.openclawConfigPath, artifacts.openclawConfigJson5, "utf-8");
  await fs.writeFile(cfg.generated.composePath, artifacts.composeYaml, "utf-8");

  if (cfg.network.mode === "restricted") {
    const allowlist = artifacts.allowlistText ?? "";
    await fs.writeFile(cfg.generated.allowlistPath, allowlist, "utf-8");
    await fs.mkdir(cfg.generated.proxyDir, { recursive: true });
    if (artifacts.proxyDockerfile) {
      await fs.writeFile(cfg.generated.proxyDockerfilePath, artifacts.proxyDockerfile, "utf-8");
    }
    if (artifacts.proxyServerJs) {
      await fs.writeFile(cfg.generated.proxyServerPath, artifacts.proxyServerJs, "utf-8");
    }
  } else {
    // Best-effort cleanup of restricted-only artifacts (do not delete user data).
    await fs.rm(cfg.generated.allowlistPath, { force: true }).catch(() => {});
  }

  if (artifacts.writeGuardRunnerJs) {
    await fs.writeFile(cfg.generated.writeGuardRunnerPath, artifacts.writeGuardRunnerJs, "utf-8");
  } else {
    await fs.rm(cfg.generated.writeGuardRunnerPath, { force: true }).catch(() => {});
  }
}

export async function upCommand(opts: UpCommandOptions): Promise<void> {
  const cfg = await loadOpenClawEnvConfig({ cwd: opts.cwd, configPath: opts.configPath });

  const summary = formatPermissionSummary(cfg);
  process.stdout.write(`${summary}\n`);

  const findings = evaluateSafety(cfg);
  const findingsText = formatFindings(findings);
  if (findingsText) {
    process.stdout.write(`${findingsText}\n`);
  }

  if (findings.hardErrors.length > 0) {
    throw new Error("Refusing to continue due to hard safety errors.");
  }

  if (findings.requiresOverride.length > 0 && !opts.iKnowWhatImDoing) {
    throw new Error(
      "This configuration includes dangerous mounts. Re-run with --i-know-what-im-doing to proceed.",
    );
  }

  const hasRiskFindings = findings.requiresConfirmation.length > 0;
  if (hasRiskFindings && opts.yes && !opts.acceptRisk) {
    throw new Error(
      "This configuration is flagged as risky (e.g. writable mounts with full network egress). Re-run with --accept-risk to proceed with --yes.",
    );
  }

  if (!opts.yes) {
    const ok = await confirmProceed(
      hasRiskFindings
        ? "This configuration is flagged as risky. Proceed anyway?"
        : "Proceed with these permissions and start the sandbox?",
    );
    if (!ok) {
      process.stdout.write("Aborted.\n");
      return;
    }
  }

  const artifacts = generateCompose(cfg);
  await writeGeneratedFiles(cfg, artifacts);

  process.stdout.write(`\nGenerated:\n- ${cfg.generated.composePath}\n`);
  process.stdout.write(`- ${cfg.generated.openclawConfigPath}\n`);
  if (cfg.network.mode === "restricted") {
    process.stdout.write(`- ${cfg.generated.allowlistPath}\n`);
    process.stdout.write(`- ${cfg.generated.proxyDir}${path.sep}\n`);
  }

  const upArgs = [
    "-f",
    cfg.generated.composePath,
    "-p",
    cfg.projectName,
    "up",
    ...(opts.attach ? [] : ["-d"]),
  ];
  await runDockerCompose(upArgs, { cwd: cfg.configDir });
}
