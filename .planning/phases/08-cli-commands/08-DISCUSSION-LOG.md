# Phase 8: CLI Commands - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-03-28
**Phase:** 08-cli-commands
**Areas discussed:** Command output format, Create command UX, Reindex & validate behavior, Error handling & edge cases

---

## Command Output Format

### Q1: How should `projects list` display results?

| Option | Description | Selected |
|--------|-------------|----------|
| Table (Recommended) | Use existing src/terminal/table.ts for consistent CLI output. Columns: Name, Status, Tasks, Owner. | ✓ |
| Compact one-liner | One line per project: name (status) - N tasks. Minimal, fast to scan. | |
| JSON only | Machine-readable output, no human formatting. | |

**User's choice:** Table (Recommended)

### Q2: Should commands support a `--json` flag?

| Option | Description | Selected |
|--------|-------------|----------|
| Yes, --json flag (Recommended) | Table by default, --json for piping to jq/scripts. | ✓ |
| No, human-readable only | Keep it simple. | |

**User's choice:** Yes, --json flag (Recommended)

### Q3: How should `projects status <name>` display detailed info?

| Option | Description | Selected |
|--------|-------------|----------|
| Grouped sections (Recommended) | Header with project name/status, then sections: Task Counts, Active Agents, Recent Activity. | ✓ |
| Single dense table | Everything in one table. | |
| You decide | Claude picks best layout. | |

**User's choice:** Grouped sections (Recommended)

---

## Create Command UX

### Q4: Interactive prompts or flags-only?

| Option | Description | Selected |
|--------|-------------|----------|
| Flags-only (Recommended) | Name as positional, --description and --owner as optional flags. Simpler, scriptable. | |
| Interactive prompts | Ask name, description, owner interactively if not provided as flags. | ✓ |
| Hybrid | Flags when provided, prompt for missing. | |

**User's choice:** Interactive prompts
**Notes:** User chose interactive prompts over the recommended flags-only approach.

### Q5: What should happen after successful project creation?

| Option | Description | Selected |
|--------|-------------|----------|
| Print path + summary (Recommended) | Show path and brief summary of what was scaffolded. | ✓ |
| Silent success | Exit 0 with no output. | |
| Open in editor | Print path and optionally open PROJECT.md in $EDITOR. | |

**User's choice:** Print path + summary (Recommended)

### Q6: Which fields should be prompted interactively?

| Option | Description | Selected |
|--------|-------------|----------|
| Name only (Recommended) | Only prompt name. Description/owner default. | |
| Name + description | Prompt name and description. Owner defaults. | |
| Name + description + owner | All three prompted per Phase 2 D-01. | ✓ |

**User's choice:** Name + description + owner

### Q7: Sub-project creation approach?

| Option | Description | Selected |
|--------|-------------|----------|
| --parent flag (Recommended) | Same command with --parent flag. Matches Phase 2 D-11. | ✓ |
| Separate subcommand | `openclaw projects create-sub`. | |

**User's choice:** --parent flag (Recommended)

### Q8: Prompt library?

| Option | Description | Selected |
|--------|-------------|----------|
| @clack/prompts (Recommended) | Already used in CLI. Consistent styling. | ✓ |
| Plain readline | No dependency but inconsistent. | |

**User's choice:** @clack/prompts (Recommended)

---

## Reindex & Validate Behavior

### Q9: What should `projects reindex` report?

| Option | Description | Selected |
|--------|-------------|----------|
| Summary counts (Recommended) | Print totals: N projects, M tasks, K locks cleared. | |
| Per-project detail | Print each project name as it's reindexed. | ✓ |
| Silent unless errors | Only print if something went wrong. | |

**User's choice:** Per-project detail
**Notes:** User chose more verbose output over the recommended summary.

### Q10: What should `projects validate` check?

| Option | Description | Selected |
|--------|-------------|----------|
| Frontmatter only (Recommended) | Check all files parse without error. Report path + error. | ✓ |
| Frontmatter + structural | Also check orphans, broken deps, missing fields. | |
| Full health check | All above plus .index/ drift detection. | |

**User's choice:** Frontmatter only (Recommended)

### Q11: Should reindex also clear stale locks?

| Option | Description | Selected |
|--------|-------------|----------|
| Yes, clear stale locks (Recommended) | Reindex is the "fix everything" command. Matches CLI-04. | ✓ |
| No, reindex only | Keep lock management separate. | |

**User's choice:** Yes, clear stale locks (Recommended)

---

## Error Handling & Edge Cases

### Q12: Missing project name handling?

| Option | Description | Selected |
|--------|-------------|----------|
| Error + list available (Recommended) | Print error then list available project names as suggestions. | ✓ |
| Error only | Print error and exit 1. | |
| Fuzzy suggest | Suggest closest match. | |

**User's choice:** Error + list available (Recommended)

### Q13: Exit codes?

| Option | Description | Selected |
|--------|-------------|----------|
| 0 success, 1 error (Recommended) | Standard Unix. Validate returns 1 if errors found. | ✓ |
| Distinct codes per error type | 0=success, 1=general, 2=not found, 3=validation failed. | |

**User's choice:** 0 success, 1 error (Recommended)

### Q14: Empty projects directory?

| Option | Description | Selected |
|--------|-------------|----------|
| Helpful message (Recommended) | Print guidance: "No projects found. Create one with..." | ✓ |
| Empty table | Show headers with no rows. | |
| Silent exit 0 | No output, just exit. | |

**User's choice:** Helpful message (Recommended)

---

## Claude's Discretion

- Route registration pattern (RouteSpec vs Commander)
- Command file organization (single file vs per-command files)
- Argument parsing details

## Deferred Ideas

None — discussion stayed within phase scope.
