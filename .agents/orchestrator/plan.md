# PROJECT PLAN: OpenClaw Fleet Setup Audit

## Architecture & Scope

Orchestrate a comprehensive audit of the OpenClaw fleet setup, grounded in YKE knowledge base data, identifying gaps, refinement opportunities, and bleeding-edge improvements. Write the audit report to `~/teamwork_projects/openclaw_audit/AUDIT_REPORT.md` (specifically `/Users/jakeshrader/teamwork_projects/openclaw_audit/AUDIT_REPORT.md`).

## Milestones

| #   | Name                            | Scope                                                                | Dependencies | Status |
| --- | ------------------------------- | -------------------------------------------------------------------- | ------------ | ------ |
| M1  | Exploration & Data Gathering    | Query YKE data plane (MCP/SQLite) for slugs and verify paths         | None         | DONE   |
| M2  | Report Composition & Generation | Draft and write structured AUDIT_REPORT.md file to target path       | M1           | DONE   |
| M3  | Verification & Review           | Review AUDIT_REPORT.md for compliance, correctness, and completeness | M2           | DONE   |

## Detailed Milestone Verification Plan

### Milestone 1: Exploration & Data Gathering

- **Explorer Subagent Tasks**:
  - Run YKE slug queries (youtube-knowledge, Notion, or web search if needed) for: `agent orchestration`, `AI model routing`, `OpenClaw`, `bleeding-edge LLM practices`, `multi-agent systems`, `fleet automation`, `cost optimization`.
  - Gather the local MacBook config from `~/.openclaw/workspace/` and `~/.openclaw/`.
  - Retrieve the remote Mini config via SSH `mac-mini-tunnel` under the `henri` user (e.g. checking files corresponding to `~/.openclaw/workspace/` and `~/.openclaw/` on Mini).
  - Inspect the 28 synced cron jobs on the system.
  - Audit across the 7 domains:
    - Agent ops
    - Model routing
    - YKE grounding
    - Fleet tooling
    - Security posture
    - Cron / automation
    - OpenClaw product integration
  - Output: `exploration_report.md` with gathered facts, configs, diffs, and YKE citations.

### Milestone 2: Report Composition & Generation

- **Worker Subagent Tasks**:
  - Read `exploration_report.md` and synthesized data.
  - Write a comprehensive, structured markdown report to `/Users/jakeshrader/teamwork_projects/openclaw_audit/AUDIT_REPORT.md`.
  - Format requirements:
    - Grounded findings with explicit inline YKE citations (youtube-knowledge, etc.) where appropriate.
    - Deep analysis of the 7 domains.
    - Explicit comparison/drift table between MacBook and Mini config files.
    - Identification of gaps, refinement opportunities, and bleeding-edge improvements.
  - Output: Written `/Users/jakeshrader/teamwork_projects/openclaw_audit/AUDIT_REPORT.md`.

### Milestone 3: Verification & Review

- **Reviewer Subagent Tasks**:
  - Read the generated `AUDIT_REPORT.md`.
  - Verify that all 7 domains are comprehensively covered.
  - Verify that the MacBook vs Mini config drift table is correct and detailed.
  - Verify that YKE citations are present, accurate, and structured correctly.
  - Verify layout, clarity, and depth.
  - Output: Review verdict (PASS/FAIL) with constructive feedback.
