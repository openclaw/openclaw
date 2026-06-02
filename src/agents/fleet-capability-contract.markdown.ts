import type {
  CapabilityCheck,
  CapabilityStatus,
  FleetCapabilityContract,
} from "./fleet-capability-contract.js";

const STATUS_ICON: Record<CapabilityStatus, string> = {
  green: "🟢",
  yellow: "🟡",
  red: "🔴",
};

function statusLabel(status: CapabilityStatus): string {
  return `${STATUS_ICON[status]} ${status}`;
}

function renderCheckRow(check: CapabilityCheck): string {
  const detail = check.detail ? check.detail.replace(/\|/g, "\\|") : "";
  return `| ${STATUS_ICON[check.status]} ${check.status} | ${check.label} | \`${check.reason}\` | ${detail} |`;
}

/**
 * Render a Fleet Capability Contract as Markdown. Pure: it only formats the
 * already-sanitized contract (which never contains secret values).
 */
export function renderFleetCapabilityMarkdown(contract: FleetCapabilityContract): string {
  const lines: string[] = [];
  lines.push("# Fleet Capability Contract v1");
  lines.push("");
  lines.push(`- Generated: ${contract.now}`);
  lines.push(
    `- Rollup: ${statusLabel(contract.rollup.status)} (🟢 ${contract.rollup.green} · 🟡 ${contract.rollup.yellow} · 🔴 ${contract.rollup.red})`,
  );
  lines.push("");

  lines.push("## Fleet services");
  lines.push("");
  lines.push("| Status | Capability | Reason | Detail |");
  lines.push("| --- | --- | --- | --- |");
  for (const check of contract.services) {
    lines.push(renderCheckRow(check));
  }
  lines.push("");

  lines.push("## Profiles");
  lines.push("");
  if (contract.profiles.length === 0) {
    lines.push("_No agent profiles configured._");
    lines.push("");
  }
  for (const profile of contract.profiles) {
    const heading =
      profile.name && profile.name !== profile.agentId
        ? `${profile.agentId} (${profile.name})`
        : profile.agentId;
    const defaultTag = profile.isDefault ? " · default" : "";
    lines.push(`### ${statusLabel(profile.status)} — ${heading}${defaultTag}`);
    lines.push("");
    lines.push("| Status | Capability | Reason | Detail |");
    lines.push("| --- | --- | --- | --- |");
    for (const check of profile.checks) {
      lines.push(renderCheckRow(check));
    }
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}
