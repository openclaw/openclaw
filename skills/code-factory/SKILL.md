---
name: code-factory
description: "Harness Engineering pattern for agent-driven development. One loop: coding agent writes code, repo enforces risk-aware checks, review agent validates PRs, evidence is machine-verifiable, findings become repeatable harness cases. Agents can implement, validate, and review with deterministic, auditable standards."
metadata: { "openclaw": { "emoji": "🏭", "requires": { "bins": ["git", "gh", "npm"] } } }
---

# Code Factory — Agent-Driven Development Loop

Set up your repo so AI agents can auto-write and review 100% of your code with deterministic, auditable standards.

## The Loop

```
Coding Agent writes code
  → Repo enforces risk-aware checks before merge
    → Review Agent validates the PR
      → Evidence (tests + browser + review) is machine-verifiable
        → Findings turn into repeatable harness cases
          → Loop back to start
```

## Step 1: Machine-Readable Risk Contract

Create `.harness/risk-policy.json` at the repo root:

```json
{
  "version": "1",
  "riskTierRules": {
    "high": [
      "app/api/**",
      "lib/tools/**",
      "db/schema.*",
      "src/auth/**",
      "src/payments/**",
      "*.config.ts",
      "*.config.js"
    ],
    "medium": ["src/components/**", "src/hooks/**", "src/utils/**"],
    "low": ["**"]
  },
  "mergePolicy": {
    "high": {
      "requiredChecks": ["risk-policy-gate", "harness-smoke", "code-review-agent", "ci-pipeline"],
      "requireBrowserEvidence": true,
      "minTestCoverage": 80
    },
    "medium": {
      "requiredChecks": ["risk-policy-gate", "ci-pipeline"],
      "requireBrowserEvidence": false,
      "minTestCoverage": 60
    },
    "low": {
      "requiredChecks": ["risk-policy-gate", "ci-pipeline"],
      "requireBrowserEvidence": false,
      "minTestCoverage": 0
    }
  },
  "docsDriftRules": {
    "trackedPaths": [".harness/**", ".github/workflows/**"],
    "requireChangelogEntry": true
  },
  "evidenceRequirements": {
    "uiFlows": {
      "requiredFlows": ["login", "signup", "checkout"],
      "maxAgeMinutes": 60,
      "requireAccountIdentity": true
    }
  }
}
```

This removes ambiguity. Every script, workflow, and agent reads the same contract.

## Step 2: Risk Policy Gate (Preflight)

Run before expensive CI. This gate verifies:

1. **Risk tier assignment** — classify changed files by tier
2. **Required checks** — verify all required checks are configured
3. **Docs drift** — ensure control-plane changes have changelog entries
4. **Review agent state** — verify code review agent is active for high-risk

```typescript
// .harness/scripts/risk-policy-gate.ts

import { readFileSync } from "node:fs";

interface RiskPolicy {
  riskTierRules: Record<string, string[]>;
  mergePolicy: Record<string, { requiredChecks: string[] }>;
}

export function computeRiskTier(changedFiles: string[], policy: RiskPolicy): string {
  for (const file of changedFiles) {
    for (const pattern of policy.riskTierRules.high ?? []) {
      if (matchGlob(file, pattern)) return "high";
    }
  }
  for (const file of changedFiles) {
    for (const pattern of policy.riskTierRules.medium ?? []) {
      if (matchGlob(file, pattern)) return "medium";
    }
  }
  return "low";
}

export function computeRequiredChecks(changedFiles: string[], policy: RiskPolicy): string[] {
  const tier = computeRiskTier(changedFiles, policy);
  return policy.mergePolicy[tier]?.requiredChecks ?? ["ci-pipeline"];
}

export async function assertDocsDriftRules(
  changedFiles: string[],
  policy: RiskPolicy,
): Promise<void> {
  const trackedPaths = (policy as any).docsDriftRules?.trackedPaths ?? [];
  const hasControlPlaneChanges = changedFiles.some((f) =>
    trackedPaths.some((p: string) => matchGlob(f, p)),
  );
  if (hasControlPlaneChanges) {
    const hasChangelog = changedFiles.some(
      (f) => f.includes("CHANGELOG") || f.includes("changelog"),
    );
    if (!hasChangelog) {
      throw new Error("Control-plane changes require a CHANGELOG entry");
    }
  }
}

function matchGlob(file: string, pattern: string): boolean {
  const regex = new RegExp("^" + pattern.replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*") + "$");
  return regex.test(file);
}
```

## Step 3: Current-Head SHA Discipline

This is critical. Review state is valid ONLY for the current PR head commit.

```typescript
// .harness/scripts/sha-discipline.ts

export async function waitForReviewOnHead(headSha: string, timeoutMinutes = 20): Promise<void> {
  const deadline = Date.now() + timeoutMinutes * 60 * 1000;

  while (Date.now() < deadline) {
    const reviewRun = await getReviewCheckRun(headSha);

    if (reviewRun?.status === "completed") {
      if (reviewRun.conclusion === "success") return;
      throw new Error(`Review failed for ${headSha}: ${reviewRun.conclusion}`);
    }

    // Wait 30 seconds between polls
    await new Promise((resolve) => setTimeout(resolve, 30_000));
  }

  throw new Error(`Review timed out after ${timeoutMinutes} minutes for ${headSha}`);
}

export function isStaleReview(reviewSha: string, currentHeadSha: string): boolean {
  return reviewSha !== currentHeadSha;
}

// After every push/synchronize: re-run policy gate on the same head
// Clear stale gate failures by rerunning
```

## Step 4: Single Rerun-Comment Writer with SHA Dedupe

Prevent duplicate bot comments and race conditions:

```typescript
// .harness/scripts/rerun-writer.ts

const MARKER = "<!-- code-review-auto-rerun -->";

export async function requestReviewRerun(
  headSha: string,
  prNumber: number,
  reviewAgentUsername: string,
): Promise<boolean> {
  const trigger = `sha:${headSha}`;

  // Check existing comments for dedup
  const comments = await listPRComments(prNumber);
  const alreadyRequested = comments.some(
    (c) => c.body.includes(MARKER) && c.body.includes(trigger),
  );

  if (alreadyRequested) {
    return false; // Already requested for this SHA
  }

  await postPRComment(
    prNumber,
    [MARKER, `@${reviewAgentUsername} please re-review`, trigger].join("\n"),
  );

  return true;
}
```

## Step 5: Automated Remediation Loop

When review findings are actionable, trigger a coding agent to fix them:

```typescript
// .harness/scripts/remediation.ts

export async function runRemediation(
  prNumber: number,
  headSha: string,
  findings: ReviewFinding[],
): Promise<void> {
  const actionableFindings = findings.filter((f) => f.severity !== "info" && f.sha === headSha);

  if (actionableFindings.length === 0) return;

  // Spawn coding agent with review context
  const task = [
    `Fix the following code review findings for PR #${prNumber}:`,
    "",
    ...actionableFindings.map(
      (f, i) => `${i + 1}. [${f.severity}] ${f.file}:${f.line} — ${f.message}`,
    ),
    "",
    "Instructions:",
    "- Read the review context and understand each finding",
    "- Make minimal, targeted fixes",
    "- Run focused local validation (typecheck + affected tests)",
    "- Commit fixes with message: 'fix: address review findings'",
    "- Do NOT bypass policy gates or skip tests",
  ].join("\n");

  // Use sessions_spawn or direct agent invocation
  await spawnRemediationAgent(task, prNumber);
}
```

## Step 6: Auto-Resolve Bot-Only Threads

After a clean current-head rerun:

```typescript
// .harness/scripts/auto-resolve.ts

export async function autoResolveBotThreads(
  prNumber: number,
  reviewBotUsername: string,
): Promise<number> {
  const threads = await listPRReviewThreads(prNumber);
  let resolved = 0;

  for (const thread of threads) {
    if (thread.isResolved) continue;

    // Check if ALL comments in thread are from the review bot
    const allFromBot = thread.comments.every((c) => c.author === reviewBotUsername);

    if (allFromBot) {
      await resolveThread(thread.id);
      resolved++;
    }
    // Never auto-resolve human-participated threads
  }

  return resolved;
}
```

## Step 7: Browser Evidence as First-Class Proof

For UI changes, require machine-verifiable evidence:

```bash
# .harness/scripts/browser-evidence.sh

# Capture browser evidence for required flows
npm run harness:ui:capture-browser-evidence

# Verify evidence manifests
npm run harness:ui:verify-browser-evidence
```

Evidence verification checks:

- Required flows exist in manifest
- Expected entrypoint was used
- Expected account identity is present for logged-in flows
- Artifacts are fresh (within maxAgeMinutes)
- Screenshots and HAR files are valid

## Step 8: Harness Gap Loop

Convert production incidents into harness cases:

```
production regression
  → create harness-gap issue
    → add test case to harness
      → track SLA for closure
        → verify case prevents regression
```

This ensures fixes aren't one-off patches but grow long-term coverage.

## GitHub Actions Workflows

### risk-policy-gate.yml

Runs first on every PR. If it fails, no other checks run.

### ci-pipeline.yml

Standard build/test/lint pipeline. Only runs after risk-policy-gate passes.

### code-review-rerun.yml

Watches for PR synchronize events. Requests re-review from the review agent for the new head SHA.

### remediation.yml

When review agent posts findings, triggers the coding agent to fix them.

### auto-resolve-threads.yml

After clean review rerun, auto-resolves bot-only threads.

## Setup Checklist

1. [ ] Create `.harness/risk-policy.json` with risk tiers for your codebase
2. [ ] Add risk-policy-gate as required check in GitHub branch protection
3. [ ] Configure code review agent (Greptile, CodeRabbit, or CodeQL)
4. [ ] Set up CI pipeline with proper test/build/lint steps
5. [ ] Add browser evidence capture for UI-heavy repos
6. [ ] Create first harness test cases from known issues
7. [ ] Enable auto-resolve for bot-only review threads
8. [ ] Configure remediation agent (Codex Action or OpenClaw agent)

## Integration with Vibeclaw

The code-factory skill works alongside Vibeclaw agents:

- **Coding agent** (OpenClaw) writes features and fixes
- **Risk policy gate** validates before CI
- **Review agent** catches issues
- **Remediation agent** fixes review findings
- **All code** flows through deterministic, auditable standards

This means Vibeclaw agents can generate code (scripts, content templates, automation) and the code factory ensures quality before merge.
