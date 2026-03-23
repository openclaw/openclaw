# Auto-Fix Skill (Bug Fix Harness)

## What It Is

The evaluation harness for the auto-fix agent. Defines what the agent can and cannot fix, how to verify fixes post-merge, and how to track fix attempts. The agent reads this skill but never modifies it.

## How It Works with Auto-Improve

The auto-fix agent is the second half of a two-agent feedback loop:

```
Session Logs
    |
    v
auto-improve (prompt optimizer)
    |-- Prompt issue? --> Edit workspace files
    |-- Platform issue? --> Create GitHub issue
    |                           |
    |                           v
    |                     auto-fix (bug fixer)
    |                           |-- In scope? --> Create PR
    |                           |-- Out of scope? --> Label needs-human
    |                           |
    |                           v
    |                     PR merged
    |                           |
    v                           v
auto-improve checks: error gone? --> Close issue (verified)
                     error persists? --> Reopen (failed)
```

## Verification Script (`scripts/check-fixes.ts`)

Cross-references fixes.tsv against current session diagnostics to verify if merged fixes actually resolved the errors.

```bash
# Check all fixes with status "merged"
bun .claude/skills/auto-fix/scripts/check-fixes.ts

# Check a specific issue
bun .claude/skills/auto-fix/scripts/check-fixes.ts --issue 42

# JSON output
bun .claude/skills/auto-fix/scripts/check-fixes.ts --json
```

## Fix Boundaries

| Allowed                             | Not Allowed                                 |
| ----------------------------------- | ------------------------------------------- |
| Bug fixes for session log errors    | New features                                |
| Timeout/retry adjustments           | Architecture changes                        |
| Missing null checks, error handling | Dependency upgrades                         |
| Config/schema corrections           | Refactoring                                 |
| RPC method registration gaps        | UI changes                                  |
| Tool schema fixes                   | Workspace prompt edits (auto-improve's job) |

## Location

```
.claude/skills/auto-fix/
|-- SKILL.md            <- fix boundaries, verification rules
|-- README.md           <- this file
|-- scripts/
|   \-- check-fixes.ts  <- post-merge verification script
\-- data/
    \-- fixes.tsv       <- fix attempt log
```

The companion agent definition is at `.claude/agents/auto-fix.md`.
