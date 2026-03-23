# Auto-Improve Skill (Evaluation Harness)

## What It Is

The fixed evaluation rulebook for the auto-improve agent. It defines how to parse session logs, compute metrics, and decide whether a prompt change helped or hurt. The agent reads this skill but never modifies it — like `prepare.py` in the AutoResearch pattern.

## Karpathy AutoResearch Mapping

This system implements the [karpathy/autoresearch](https://github.com/karpathy/autoresearch) pattern:

| AutoResearch     | Purpose                                                       | Our Equivalent                                                  |
| ---------------- | ------------------------------------------------------------- | --------------------------------------------------------------- |
| `prepare.py`     | Fixed eval harness — deterministic scoring script             | `scripts/score.ts` + `SKILL.md`                                 |
| `train.py`       | The "model" being optimized — the only thing the agent edits  | `workspaces/*/AGENTS.md`, `SOUL.md`, `TOOLS.md`, `HEARTBEAT.md` |
| `program.md`     | Instructions for the AI agent — what to do, how to experiment | `.claude/agents/auto-improve.md`                                |
| `analysis.ipynb` | Notebook for visualizing progress over time                   | `data/results.tsv` (viewable in any spreadsheet/charting tool)  |

## Scoring Script (`scripts/score.ts`)

The deterministic scoring engine — equivalent to `prepare.py`. Parses real JSONL session logs and computes all 9 metrics with no LLM involvement.

```bash
# Full human-readable report
bun .claude/skills/auto-improve/scripts/score.ts

# JSON output for programmatic use
bun .claude/skills/auto-improve/scripts/score.ts --json

# TSV row for appending to results.tsv
bun .claude/skills/auto-improve/scripts/score.ts --tsv-row

# Score a specific agent
bun .claude/skills/auto-improve/scripts/score.ts --agent neo

# Analyze more/fewer sessions
bun .claude/skills/auto-improve/scripts/score.ts --sessions 10
```

The agent calls `--tsv-row` to get a pre-formatted row it can append to `data/results.tsv` after each iteration.

### Platform Diagnostics (`--diagnostics`)

Detects platform-level issues that can't be fixed by prompt edits:

```bash
bun .claude/skills/auto-improve/scripts/score.ts --diagnostics
```

Outputs a JSON array of detected issues classified by category:

- `tool-timeout` — tool calls that timed out
- `mcp-integration` — MCP server connection failures
- `gateway-rpc` — RPC handler errors
- `session-stability` — session aborts, prompt errors
- `tool-pipeline` — subagent tool execution failures (text echo)
- `auth` — permission/authorization errors
- `schema-validation` — schema mismatches

The auto-improve agent uses this to create GitHub issues for the auto-fix agent to pick up.

## What SKILL.md Contains

### Session Log Schema

How to parse `~/.openclaw/agents/*/sessions/*.jsonl` files — entry types (`session`, `message`, `model_change`, etc.), message structure, and how to extract tool calls vs text responses.

### 9 Metrics

| #   | Metric                 | Scope        | In Composite | Weight |
| --- | ---------------------- | ------------ | ------------ | ------ |
| 1   | Delegation ratio       | Operator1    | Yes          | 0.30   |
| 2   | Memory usage rate      | Operator1    | Yes          | 0.20   |
| 3   | Conciseness            | Operator1    | Yes          | 0.15   |
| 4   | Silent reply accuracy  | Operator1    | Yes          | 0.15   |
| 5   | Tool error rate        | Operator1    | Yes          | 0.20   |
| 6   | Tool execution rate    | Per subagent | No           | -      |
| 7   | Memory write-back rate | Per agent    | No           | -      |
| 8   | Memory retrieval rate  | Per agent    | No           | -      |
| 9   | Memory richness        | Per agent    | No           | -      |

Metrics 1-5 produce a composite score (0.0-1.0) that drives keep/discard decisions. Metrics 6-9 are diagnostics tracked in `results.tsv` but don't affect the composite.

### Keep/Discard Thresholds

- Score improved by >0.01 -> **keep**
- Score within 0.01 -> **keep** (simpler is valued)
- Score dropped by >0.01 -> **discard** (revert)

### File Access Matrix

Enforced permissions — which workspace files the agent can read, which it can write, and which are off-limits.

### Results Format

Schema for `results.tsv` — tab-separated columns for commit SHA, all metric scores, per-agent diagnostics, status, and description.

## Relationship to the Agent

The **agent** (`.claude/agents/auto-improve.md`) is the loop — it knows _what_ to do (collect logs, make changes, sleep, repeat). The **skill** (this file's `SKILL.md`) is the rulebook — it knows _how_ to score and _when_ to keep or discard. The **script** (`scripts/score.ts`) is the executable implementation of the rulebook.

```
Agent dispatched
  |-- Invokes Skill tool: "auto-improve"
  |     \-- SKILL.md loaded into context (rules, thresholds, permissions)
  |
  |-- Runs: bun scripts/score.ts --tsv-row
  |     \-- Deterministic scores returned (no LLM math)
  |
  |-- Identifies weakest metric, edits ONE workspace file
  |-- Commits, restarts gateway, sleeps 10m
  \-- Loops back to scoring
```

## Location

```
.claude/skills/auto-improve/
|-- SKILL.md          <- evaluation rules (loaded via Skill tool)
|-- README.md         <- this file
|-- scripts/
|   \-- score.ts      <- deterministic scoring engine (prepare.py equivalent)
\-- data/
    \-- results.tsv   <- iteration-by-iteration scoring log
```

The companion agent definition is at `.claude/agents/auto-improve.md`.
The sibling system is auto-fix (`.claude/skills/auto-fix/`, `.claude/agents/auto-fix.md`).

This lives under `.claude/skills/` (Claude Code's skill directory) so it's discoverable by the Skill tool and appears in the available skills list.
