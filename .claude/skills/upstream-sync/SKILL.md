---
name: upstream-sync
description: Selectively cherry-pick fixes and features from upstream repositories into operator1. Supports multiple upstreams — OpenClaw (primary) and Paperclip (UI patterns for onboarding). Use when the user says "sync upstream", "cherry-sync", "pick upstream", "sync to v2026.x.x", "sync paperclip", or wants to review what's new upstream. Orchestrates sync-lead, code-guard, and qa-runner agents following the selective cherry-pick pipeline with per-category phased PRs.
---

# Upstream Cherry-Pick Sync

Selectively cherry-pick changes from upstream repositories into operator1. Supports multiple upstream sources, each with their own phase categories, scope filters, and adaptation rules.

## Supported Upstreams

| Source                 | Remote                                | Tracking                          | Phase model                                                                   | Scope              |
| ---------------------- | ------------------------------------- | --------------------------------- | ----------------------------------------------------------------------------- | ------------------ |
| **openclaw** (default) | `upstream` → `openclaw/openclaw`      | Tag-based (`v2026.x.x`)           | 6-phase (security → bugfixes → features → provider → review → ui-inspiration) | Full codebase      |
| **paperclip**          | `paperclip` → `paperclipai/paperclip` | Commit-based (no formal releases) | 3-phase (onboarding → forms → ui)                                             | UI components only |

## Usage

```
# OpenClaw (default — same as before)
/upstream-sync [target-tag]
/upstream-sync --review              ← just identify & classify, don't pick
/upstream-sync --phase <name>        ← run a specific phase (security, bugfixes, features, etc.)
/upstream-sync --phase next          ← auto-pick the next pending phase
/upstream-sync --resume              ← continue from last incomplete phase
/upstream-sync --full-merge          ← escape hatch: full git merge (rare, see §8)

# Paperclip (UI patterns for onboarding)
/upstream-sync --source paperclip                    ← sync latest from Paperclip main
/upstream-sync --source paperclip <commit-sha>       ← sync up to specific commit
/upstream-sync --source paperclip --review           ← classify only, don't pick
/upstream-sync --source paperclip --phase onboarding ← run specific phase

Examples:
  /upstream-sync v2026.3.12                          ← OpenClaw sync (default)
  /upstream-sync                                     ← sync-lead checks upstream and asks
  /upstream-sync --source paperclip                  ← Paperclip UI sync
  /upstream-sync --source paperclip --review         ← dry-run: classify Paperclip changes
  /upstream-sync --phase security                    ← OpenClaw: cherry-pick security fixes
  /upstream-sync --source paperclip --phase forms    ← Paperclip: cherry-pick form patterns
```

## Phased PR Workflow

Each upstream sync is broken into **per-category phases**, each with its own branch and PR. This keeps PRs focused, reviewable, and independently mergeable.

### OpenClaw Phases (6-phase model)

| Phase | Category          | Branch Pattern                 | Priority                                  |
| ----- | ----------------- | ------------------------------ | ----------------------------------------- |
| 1     | Security          | `sync/<tag>-security`          | Critical — merge first                    |
| 2     | Bug Fixes         | `sync/<tag>-bugfixes`          | High                                      |
| 3     | Features          | `sync/<tag>-features`          | Medium                                    |
| 4     | Provider/Refactor | `sync/<tag>-provider-refactor` | Medium — align with upstream architecture |
| 5     | Review Items      | `sync/<tag>-review`            | Triaged during Phase 2 approval           |
| 6     | UI Inspiration    | `sync/<tag>-ui-inspiration`    | Reference — draft PR                      |

### Paperclip Phases (3-phase model)

| Phase | Category      | Branch Pattern                    | Priority                          |
| ----- | ------------- | --------------------------------- | --------------------------------- |
| 1     | Onboarding UI | `sync/paperclip-<sha>-onboarding` | High — wizard shell & steps       |
| 2     | Form Patterns | `sync/paperclip-<sha>-forms`      | Medium — validation & dirty state |
| 3     | UI Components | `sync/paperclip-<sha>-ui`         | Low — shared shadcn/ui updates    |

### Sequencing

Each phase branches from `main` AFTER the prior phase's PR is merged:

```
# OpenClaw
main ── P1 (security) ──merge── P2 (bugfixes) ──merge── P3 (features) ──merge── P4 (provider) ──merge── P5 (review) ──merge── P6 (ui-insp, draft)

# Paperclip
main ── P1 (onboarding) ──merge── P2 (forms) ──merge── P3 (ui)
```

## How It Works

### Source Selection

When `--source` is specified, sync-lead uses the corresponding remote, phase model, scope filter, and adaptation rules. Default is `openclaw`.

- **openclaw:** `git fetch upstream --tags` → tag-based release detection → 6-phase model → full-scope conflict strategies
- **paperclip:** `git fetch paperclip` → commit-based range → 3-phase model → UI-only scope filter → adaptation rules (React Query → sendRpc, remove REST/Drizzle/multi-tenant)

### Flow

```
You: "/upstream-sync v2026.3.12"                    ← openclaw (default)
You: "/upstream-sync --source paperclip"             ← paperclip UI sync
         │
    sync-lead (sonnet)
    ├── Phase 0: Fetch <source> remote, identify next release candidate (tag or commit)
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
    │   ├── Spawn docs-updater on sync branch ───────────────┐
    │   │                                                     │
    │   │   docs-updater (sonnet)                             │
    │   │   ├── Scan phase commits for doc-relevant changes  │
    │   │   ├── Update relevant docs/ pages                  │
    │   │   ├── Commit doc updates to sync branch            │
    │   │   └── Report what was updated ─────────────────────┘
    │   │
    │   ├── Push branch, open PR (includes doc updates), update sync-state.json
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

| Agent          | Role                                                                                                | Model  | Tools                                      |
| -------------- | --------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------ |
| `sync-lead`    | Orchestrator — fetches, classifies into phases, coordinates, records                                | sonnet | Bash, Read, Write, Edit, Glob, Grep, Agent |
| `code-guard`   | Cherry-pick & conflict specialist — picks commits for one phase, resolves per §6, audits registries | sonnet | Bash, Read, Write, Edit, Glob, Grep        |
| `qa-runner`    | Validation — build, test, lint, UI, §7.1 checklist                                                  | sonnet | Bash, Read, Grep                           |
| `docs-updater` | Documentation maintenance — scans changes, updates relevant docs                                    | sonnet | Bash, Read, Write, Edit, Glob, Grep        |

## Key Reference Files

The agents read these automatically:

| File                                                    | Purpose                                                 |
| ------------------------------------------------------- | ------------------------------------------------------- |
| `Project-tasks/upstream-selective-sync-process.md`      | Full process doc for OpenClaw sync (§1-10)              |
| `Project-tasks/onboarding-gui-implementation.md` §2.5   | Paperclip sync strategy, scope filter, adaptation rules |
| `.claude/skills/upstream-sync/state/protected-files.md` | Operator1 files that must survive                       |
| `.claude/skills/upstream-sync/state/sync-state.json`    | Last synced tag/commit, per-phase progress, history     |
| `CLAUDE.md`                                             | Build commands, project conventions                     |

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

Spawn the sync-lead agent to begin the cherry-pick sync process.

**Parse the `--source` argument** to determine which upstream to sync from:

- `--source openclaw` (default if omitted): OpenClaw upstream sync
- `--source paperclip`: Paperclip UI patterns sync

Pass the source to sync-lead so it uses the correct remote, phase model, scope filter, and state key.

**Other flags:**

- Default: runs Phase 0-2 (identify + classify), then loops through phases with user approval gates
- `--review`: stops after Phase 2 (classification) without cherry-picking
- `--phase <name>`: runs only the specified phase (assumes classification is already done)
- `--phase next`: auto-picks the next pending phase from `currentSync.phases`
- `--resume`: same as `--phase next`
- `--full-merge`: (OpenClaw only) escape hatch for full git merge
