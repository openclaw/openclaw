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
  {
    id: "exact-artifact-replay",
    re: /if user provides an exact query, event ID, trace ID, address, or says the prior answer is wrong/i,
    message: "missing exact-artifact replay guidance",
  },
  {
    id: "live-sentry-or-blocked",
    re: /use Sentry event IDs only after a live lookup, or explicitly say creds are unavailable/i,
    message: "missing live-sentry lookup or credential-block guidance",
  },
  {
    id: "no-cross-resolver-reuse",
    re: /do not reuse a prior incident unless operation name, schema object, failing fields, chain, and address pattern match/i,
    message: "missing anti-anchoring / cross-resolver reuse guidance",
  },
  {
    id: "no-progress-only-thread-replies",
    re: /do not send progress-only (thread )?replies/i,
    message: "missing no-progress-only incident thread guidance",
  },
  {
    id: "repo-access-live-probe",
    re: /Before claiming repo\/tool access is unavailable, run one live probe/i,
    message: "missing live probe requirement before repo/tool access disclaimers",
  },
  {
    id: "fix-challenge-reopens-rca",
    re: /If a human questions the proposed fix or PR in-thread, re-open RCA/i,
    message: "missing re-open RCA guidance when humans challenge the fix",
  },
  {
    id: "disproved-theory-contract",
    re: /Disproved theory:/,
    message: "missing disproved-theory handoff when evidence contradicts prior RCA",
  },
  {
    id: "rewards-db-provenance-gate",
    re: /before naming a stale-row\/write-path cause or opening a PR, include one live DB row\/provenance fact/i,
    message: "missing rewards/provider DB provenance gate before stale-row PRs",
  },
  {
    id: "rewards-code-path-gate",
    re: /exact consuming (repo\/path|code-path)( fact)?/i,
    message: "missing rewards/provider exact consuming code-path gate before stale-row PRs",
  },
  {
    id: "rewards-same-token-both-sides",
    re: /same reward token appears on both supply and borrow/i,
    message: "missing same-token both-sides rewards/provider guidance",
  },
  {
    id: "single-vault-workflow",
    re: /## Single-Vault API \/ GraphQL Data Incidents/,
    message: "missing single-vault api/graphql workflow",
  },
  {
    id: "single-vault-helper",
    re: /single-vault-graphql-evidence\.sh/,
    message: "missing single-vault graphql evidence helper guidance",
  },
  {
    id: "same-chain-control",
    re: /compare against one healthy control vault on the same chain/i,
    message: "missing same-chain control comparison guidance",
  },
  {
    id: "public-surface-compare",
    re: /vaultV2ByAddress[\s\S]*vaultV2s[\s\S]*vaultV2transactions/i,
    message: "missing public-surface comparison guidance for single-vault incidents",
  },
  {
    id: "retract-after-contradiction",
    re: /explicitly retract|retract the outdated theory|retract.*prior theory/i,
    message:
      "missing explicit retract-and-restart guidance when new evidence contradicts prior theory",
  },
  {
    id: "single-vault-provenance-gate",
    re: /DB row\/provenance fact[\s\S]*job-path or simulation fact/i,
    message: "missing DB provenance and job-simulation gate for single-vault ingestion theories",
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
  return path.resolve("skills", "morpho-sre", "SKILL.md");
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
  skills/morpho-sre/SKILL.md`);
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
