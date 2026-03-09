#!/usr/bin/env -S node --import tsx

import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export type SkillGuardrailIssue = {
  id: string;
  message: string;
};

const REQUIRED_RULES: Array<{ id: string; re: RegExp; message: string }> = [
  {
    id: "hard-preflight",
    re: /Hard preflight before diagnosis:/,
    message: "missing hard preflight section",
  },
  {
    id: "binary-check",
    re: /command -v kubectl aws jq git gh/,
    message: "missing binary/PATH preflight command",
  },
  {
    id: "shell-portability",
    re: /Shell portability:/,
    message: "missing shell portability guidance",
  },
  {
    id: "bash-explicit",
    re: /bash -lc/,
    message: "missing explicit bash wrapper guidance",
  },
  {
    id: "blocked-mode",
    re: /Blocked Mode Reply Contract/,
    message: "missing blocked mode reply contract",
  },
  {
    id: "blocked-exact-error",
    re: /\*Evidence:\* <exact command> -> <exact error>/,
    message: "blocked mode does not require exact command/error echo",
  },
  {
    id: "no-speculation-before-evidence",
    re: /No root-cause ranking before one successful live check/,
    message: "missing no-speculation-before-evidence rule",
  },
  {
    id: "rback-fallback",
    re: /RBAC-aware fallback:/,
    message: "missing RBAC-aware fallback section",
  },
  {
    id: "pods-exec-forbidden",
    re: /pods\/exec forbidden|kubectl exec/,
    message: "RBAC fallback does not mention exec-forbidden behavior",
  },
  {
    id: "retrieval-before-repo",
    re: /Before broad repo\/code reads, load at least one retrieval surface/,
    message: "missing retrieval-before-repo guidance",
  },
  {
    id: "knowledge-index",
    re: /knowledge-index\.md/,
    message: "missing knowledge-index retrieval reference",
  },
  {
    id: "runbook-map",
    re: /runbook-map\.md/,
    message: "missing runbook-map retrieval reference",
  },
];

export function validateMorphoSreSkillText(text: string): SkillGuardrailIssue[] {
  const issues: SkillGuardrailIssue[] = [];
  for (const rule of REQUIRED_RULES) {
    if (!rule.re.test(text)) {
      issues.push({ id: rule.id, message: rule.message });
    }
  }
  return issues;
}

async function validateFile(filePath: string): Promise<SkillGuardrailIssue[]> {
  const raw = await fs.readFile(filePath, "utf8");
  return validateMorphoSreSkillText(raw);
}

function defaultSkillPath(): string {
  return path.resolve(
    "..",
    "morpho-infra-helm",
    "charts",
    "openclaw-sre",
    "files",
    "seed-skills",
    "SKILL.md",
  );
}

function printHelp(): void {
  console.log(`Usage: node --import tsx scripts/check-sre-skill-guardrails.ts [skill-path]

Validates that the Morpho SRE skill keeps the required guardrails:
- hard preflight
- shell portability
- blocked mode contract
- RBAC fallback
- retrieval-before-repo rules

Default path:
  ../morpho-infra-helm/charts/openclaw-sre/files/seed-skills/SKILL.md`);
}

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (arg === "--help" || arg === "-h") {
    printHelp();
    return;
  }
  const target = path.resolve(arg ?? defaultSkillPath());
  const issues = await validateFile(target);
  if (issues.length === 0) {
    console.log(`Skill guardrails OK: ${target}`);
    return;
  }
  console.error(`Skill guardrail check failed: ${target}`);
  for (const issue of issues) {
    console.error(`- ${issue.id}: ${issue.message}`);
  }
  process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(`check-sre-skill-guardrails: ${String(err)}`);
    process.exitCode = 1;
  });
}
