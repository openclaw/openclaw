#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

function parseArgs(argv) {
  const args = {
    repo: process.cwd(),
    outputDir: path.join(homedir(), ".openclaw", "review", "dev-challenge"),
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") {
      continue;
    } else if (arg === "--repo") {
      args.repo = argv[++i] ?? args.repo;
    } else if (arg === "--output-dir") {
      args.outputDir = argv[++i] ?? args.outputDir;
    } else if (arg === "--json") {
      args.json = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/dev-challenge-pack.mjs [options]

Create local DEV OpenClaw Challenge submission drafts and checklist.

Options:
  --repo <path>          Repository path
  --output-dir <path>    Output folder (default: ~/.openclaw/review/dev-challenge)
  --json                 Print manifest JSON
`);
}

function newestDir(parent) {
  if (!existsSync(parent)) {
    return null;
  }
  const dirs = readdirSync(parent, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(parent, entry.name))
    .toSorted()
    .toReversed();
  return dirs[0] ?? null;
}

function readMaybe(file, maxChars = 3000) {
  if (!existsSync(file)) {
    return "";
  }
  return readFileSync(file, "utf8").slice(0, maxChars);
}

function write(file, text) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${text.trimEnd()}\n`, { mode: 0o600 });
}

function buildManifest(args) {
  const repo = path.resolve(args.repo);
  const artifactsRoot = path.join(repo, ".artifacts");
  const browserRun = newestDir(path.join(artifactsRoot, "playwright-flows"));
  const hardening = readMaybe(
    path.join(homedir(), ".openclaw", "reports", "hardening", "latest.md"),
  );
  const headless = readMaybe(
    path.join(homedir(), ".openclaw", "reports", "headless-capabilities", "latest.md"),
  );
  const roi = readMaybe(path.join(homedir(), ".openclaw", "review", "repo-roi", "latest.md"));
  const jit = readMaybe(path.join(repo, ".artifacts", "jit-diff-test-plan.md"));
  return {
    generatedAt: new Date().toISOString(),
    challengeUrl: "https://dev.to/challenges/openclaw-2026-04-16/",
    deadline: "2026-04-26T23:59:00-07:00",
    repo,
    outputDir: path.resolve(args.outputDir),
    evidence: {
      browserRun,
      browserResult: browserRun ? path.join(browserRun, "result.json") : null,
      hardeningAvailable: hardening.length > 0,
      headlessAvailable: headless.length > 0,
      repoRoiAvailable: roi.length > 0,
      jitPlanAvailable: jit.length > 0,
    },
  };
}

function actionDraft(manifest) {
  return `---
title: "I Hardened My Always-On OpenClaw Mac Mini into a Reviewable Agent Platform"
published: false
tags: openclawchallenge, openclaw, ai, automation
---

## What I Built

I turned a fragile always-on OpenClaw install into a safer local agent platform with:

- a hardening audit for gateway, cron, model, secret, and exec policy drift
- a JiT diff-test planner inspired by change-specific catching tests
- a real browser-flow runner with screenshots, traces, and result JSON
- a repo ROI playbook for deciding what to delegate to agents
- a headless capability registry that lists CLI, workflow, and browser automation surfaces
- a deterministic agent-script validator for human-checkpoint workflows

## Why It Matters

Always-on agents are valuable only when they are observable, bounded, and easy to review. The high-ROI move was not adding more autonomous jobs. It was making every recurring capability inspectable before cron or public channels can use it.

## Demo

Commands:

\`\`\`bash
pnpm audit:hardening
pnpm test:jit:plan
pnpm browser:flow -- --spec automation/browser-flows/openclaw-dashboard-smoke.json
pnpm repo:roi
pnpm headless:registry
pnpm agent-script:check -- --file automation/agent-scripts/human-checkpoint-review.json
\`\`\`

Browser artifact from the dashboard smoke flow:

\`\`\`text
${manifest.evidence.browserRun ?? "Run pnpm browser:flow to generate artifacts."}
\`\`\`

## What I Learned

- Cron should stay disabled until each job has a bounded model, timeout, and review path.
- Secrets do not belong in agent-readable runtime files.
- Browser automation is most useful when every run leaves traceable artifacts.
- Repo-wide agent work needs a playbook, not a vague "improve this repo" prompt.
- Headless capabilities make agents useful across surfaces without depending on a UI.

## Source and Credits

This submission builds on my local OpenClaw setup and cites public inspiration from NVIDIA NemoClaw/OpenShell, Meta JiT testing coverage, Salesforce Headless 360, and the DEV OpenClaw Challenge prompt. No third-party code was copied into the implementation.
`;
}

function knowledgeDraft() {
  return `---
title: "A Practical Pattern for Safer Always-On OpenClaw Agents"
published: false
tags: openclawchallenge, openclaw, testing, automation
---

The highest-ROI OpenClaw pattern I found is simple:

> Do not make the agent more autonomous until its capabilities are easier to audit than to run manually.

My local pattern has five layers:

1. **Hardening audit**: verify loopback binding, token auth, allowlisted exec, disabled cron, and no secret-like LaunchAgent env keys.
2. **JiT catching tests**: generate a diff-specific test plan instead of relying only on stale broad suites.
3. **Browser flows**: run real Playwright-backed browser checks and save screenshots/traces for review.
4. **Repo ROI playbook**: delegate repo familiarization, mechanical refactors, docs drift, and PR scaffolding only when review is cheap.
5. **Headless registry**: expose repeatable work as CLI commands, workflow prompts, and browser flows.

The result is an agent system where scheduled work drafts reports and proposals, while humans keep control over publishing, merging, credentials, and external state.

## Minimal Commands

\`\`\`bash
pnpm audit:hardening
pnpm test:jit:plan
pnpm browser:flow -- --spec automation/browser-flows/openclaw-dashboard-smoke.json
pnpm repo:roi
pnpm headless:registry
\`\`\`

## The Rule I Would Reuse

If a task is expensive for a human to context-load but cheap to verify, delegate it. If it changes external state, require a human checkpoint.
`;
}

function checklist(manifest) {
  return `# DEV OpenClaw Challenge Checklist

Challenge: ${manifest.challengeUrl}
Deadline: ${manifest.deadline}

## Submission Paths

- OpenClaw in Action draft: \`openclaw-in-action.md\`
- Wealth of Knowledge draft: \`wealth-of-knowledge.md\`

## Before Publishing

- [ ] Confirm eligibility and official rules.
- [ ] Pick one prompt or publish separate posts for both prompts.
- [ ] Add screenshots or artifact links from the browser smoke run.
- [ ] Credit inspirations and prior work.
- [ ] Remove private paths, tokens, logs, and any sensitive business context.
- [ ] Run the demo commands once more.
- [ ] Human review before publishing to DEV.

## Evidence

- Browser run: ${manifest.evidence.browserRun ?? "not generated"}
- Browser result: ${manifest.evidence.browserResult ?? "not generated"}
- Hardening report available: ${manifest.evidence.hardeningAvailable}
- Headless registry report available: ${manifest.evidence.headlessAvailable}
- Repo ROI report available: ${manifest.evidence.repoRoiAvailable}
- JiT plan available: ${manifest.evidence.jitPlanAvailable}
`;
}

const args = parseArgs(process.argv.slice(2));
const manifest = buildManifest(args);
write(path.join(manifest.outputDir, "openclaw-in-action.md"), actionDraft(manifest));
write(path.join(manifest.outputDir, "wealth-of-knowledge.md"), knowledgeDraft());
write(path.join(manifest.outputDir, "checklist.md"), checklist(manifest));
write(path.join(manifest.outputDir, "manifest.json"), JSON.stringify(manifest, null, 2));
if (args.json) {
  console.log(JSON.stringify(manifest, null, 2));
} else {
  console.log(`DEV challenge pack written to ${manifest.outputDir}`);
}
