import { loadOpenClawEnvConfig } from "../config/load.js";
import { evaluateSafety } from "../security/warnings.js";
import { formatPermissionSummary } from "./summary.js";

export type PrintCommandOptions = {
  cwd: string;
  configPath?: string;
};

function formatFindings(findings: ReturnType<typeof evaluateSafety>): string | null {
  const all = findings.findings;
  if (all.length === 0) {
    return null;
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

export async function printCommand(opts: PrintCommandOptions): Promise<void> {
  const cfg = await loadOpenClawEnvConfig({ cwd: opts.cwd, configPath: opts.configPath });
  const summary = formatPermissionSummary(cfg);
  process.stdout.write(`${summary}\n`);

  const findings = evaluateSafety(cfg);
  const findingsText = formatFindings(findings);
  if (findingsText) {
    process.stdout.write(`${findingsText}\n`);
  }
}
