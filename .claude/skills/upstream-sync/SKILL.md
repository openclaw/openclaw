---
name: upstream-sync
description: Selectively cherry-pick fixes and features from upstream OpenClaw into operator1. Use when the user says "sync upstream", "cherry-sync", "pick upstream", "sync to v2026.x.x", or wants to review what's new upstream. Orchestrates sync-lead, code-guard, and qa-runner agents following the selective cherry-pick pipeline with per-category phased PRs.
---

# Upstream Cherry-Pick Sync

Selectively cherry-pick upstream OpenClaw changes into operator1 using the process defined in `Project-tasks/upstream-selective-sync-process.md`.

## Usage

```
/upstream-sync [target-tag]
/upstream-sync --review              ← just identify & classify, don't pick
/upstream-sync --phase <name>        ← run a specific phase (security, bugfixes, features, etc.)
/upstream-sync --phase next          ← auto-pick the next pending phase
/upstream-sync --resume              ← continue from last incomplete phase
/upstream-sync --full-merge          ← escape hatch: full git merge (rare, see §8)

Examples:
  /upstream-sync v2026.3.12
  /upstream-sync                     ← sync-lead will check upstream and ask
  /upstream-sync --review            ← dry-run: show what's new, classify, stop
  /upstream-sync --phase security    ← cherry-pick only security fixes
  /upstream-sync --phase next        ← pick up where we left off
```

## Phased PR Workflow

Each upstream sync is broken into **per-category phases**, each with its own branch and PR. This keeps PRs focused, reviewable, and independently mergeable.

### Phases (in order)

| Phase | Category          | Branch Pattern                 | Priority                                  |
| ----- | ----------------- | ------------------------------ | ----------------------------------------- |
| 1     | Security          | `sync/<tag>-security`          | Critical — merge first                    |
| 2     | Bug Fixes         | `sync/<tag>-bugfixes`          | High                                      |
| 3     | Features          | `sync/<tag>-features`          | Medium                                    |
| 4     | Provider/Refactor | `sync/<tag>-provider-refactor` | Medium — align with upstream architecture |
| 5     | Review Items      | `sync/<tag>-review`            | Triaged during Phase 2 approval           |
| 6     | UI Inspiration    | `sync/<tag>-ui-inspiration`    | Reference — draft PR                      |

### Sequencing

Each phase branches from `main` AFTER the prior phase's PR is merged:

```
main ── P1 (security) ──merge── P2 (bugfixes) ──merge── P3 (features) ──merge── P4 (provider) ──merge── P5 (review) ──merge── P6 (ui-insp, draft)
```

## How It Works

```
You: "/upstream-sync v2026.3.12"
         │
    sync-lead (sonnet)
    ├── Phase 0: Fetch upstream, identify next release candidate
    ├── Phase 1: Diff changelog, list commits
    ├── Phase 2: Classify into 6 category buckets, present plan to user
    │            ← YOU APPROVE: "adopt these, skip those"
    │            ← REVIEW items triaged to adopt/skip
    │            ← Save sync report with per-phase commit lists
    │
    │   FOR EACH PHASE (security → bugfixes → features → provider → review → ui-inspiration):
    │   │
    │   ├── Phase 3: spawn code-guard ─────────────────────────┐
    │   │                                                      │
    │   │   code-guard (opus)                                  │
    │   │   ├── Create sync/<tag>-<phase> branch from main    │
    │   │   ├── Batch dry-run (--no-commit, build)            │
    │   │   ├── Cherry-pick -x each commit for this phase     │
    │   │   ├── Resolve conflicts per §6 table                │
    │   │   ├── Run post-cherry-pick audit                    │
    │   │   └── Report back ──────────────────────────────────┘
    │   │
    │   ├── Phase 4: spawn qa-runner ──────────────────────────┐
    │   │                                                      │
    │   │   qa-runner (sonnet)                                 │
    │   │   ├── pnpm install && pnpm build && pnpm test       │
    │   │   ├── cd ui-next && pnpm build                      │
    │   │   ├── Run §7.1 cherry-pick checklist                │
    │   │   └── Report pass/fail ─────────────────────────────┘
    │   │
    │   │   (loop: if qa fails → code-guard fixes → qa reruns)
    │   │   ← HARD GATE: PR cannot open until qa-runner passes (four-eyes)
    │   │
    │   ├── Push branch, open PR, update sync-state.json
    │   ├── STOP — present PR to user for review
    │   │            ← USER APPROVES: "merge it" / "looks good"
    │   ├── Merge PR (regular merge, preserve -x traceability)
    │   ├── git checkout main && git pull
    │   ├── Prompt user for hands-on testing on main
    │   │            ← USER CONFIRMS: "testing passed" / "all good"
    │   ├── Update sync-state.json phase → completed
    │   └── Report phase complete, list remaining phases
    │
    ├── After ALL phases complete:
    │   ├── Update lastSyncedTag in sync-state.json
    │   ├── Collapse currentSync into history
    │   └── Update sync log in process doc
    └── Report final summary
```

## Agents Involved

| Agent        | Role                                                                                                | Model  | Tools                                      |
| ------------ | --------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------ |
| `sync-lead`  | Orchestrator — fetches, classifies into phases, coordinates, records                                | sonnet | Bash, Read, Write, Edit, Glob, Grep, Agent |
| `code-guard` | Cherry-pick & conflict specialist — picks commits for one phase, resolves per §6, audits registries | sonnet | Bash, Read, Write, Edit, Glob, Grep        |
| `qa-runner`  | Validation — build, test, lint, UI, §7.1 checklist                                                  | sonnet | Bash, Read, Grep                           |

## Key Reference Files

The agents read these automatically:

| File                                                    | Purpose                                      |
| ------------------------------------------------------- | -------------------------------------------- |
| `Project-tasks/upstream-selective-sync-process.md`      | Full process doc (§1-10)                     |
| `.claude/skills/upstream-sync/state/protected-files.md` | Operator1 files that must survive            |
| `.claude/skills/upstream-sync/state/sync-state.json`    | Last synced tag, per-phase progress, history |
| `CLAUDE.md`                                             | Build commands, project conventions          |

## Current Sync State

Last synced tag and per-phase progress:

```bash
cat .claude/skills/upstream-sync/state/sync-state.json
```

## When to Use Full Merge Instead (§8)

The `--full-merge` flag triggers the old `git merge upstream/main` approach. Use only when:

- Cumulative skipped commits > 500
- Same dependency chain deferred 3+ times
- Upstream ships a foundational change we need
- Cherry-pick burden per release consistently exceeds 4 hours

## Invoke

Spawn the sync-lead agent to begin the cherry-pick sync process:

- Default: runs Phase 0-2 (identify + classify), then loops through phases with user approval gates
- `--review`: stops after Phase 2 (classification) without cherry-picking
- `--phase <name>`: runs only the specified phase (assumes classification is already done)
- `--phase next`: auto-picks the next pending phase from `currentSync.phases`
- `--resume`: same as `--phase next`
