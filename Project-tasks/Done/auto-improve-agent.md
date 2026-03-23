---
title: "Auto-Improve Agent for Operator1"
description: "Autonomous agent that analyzes gateway logs and iteratively improves Operator1 workspace prompts"
dartboard: "Operator1/Tasks"
type: Project
status: "In Progress"
priority: high
assignee: "rohit sharma"
tags: [feature, agent, prompting, automation]
startAt: "2026-03-22"
dueAt: ""
dart_project_id:
---

# Auto-Improve Agent for Operator1

**Created:** 2026-03-22
**Status:** In Progress
**Inspired by:** [karpathy/autoresearch](https://github.com/karpathy/autoresearch)

## 1. Goal

Create a Claude Code agent that autonomously analyzes Operator1's gateway session logs, scores response quality using heuristic metrics, and iteratively improves the workspace prompt files — committing changes that improve metrics, reverting changes that don't.

## 2. Architecture Mapping (AutoResearch → Operator1)

| AutoResearch                      | Operator1 Adaptation                                                               |
| --------------------------------- | ---------------------------------------------------------------------------------- |
| `prepare.py` (fixed eval harness) | Skill: `skills/auto-improve/SKILL.md` — scoring formulas, JSONL schema, thresholds |
| `train.py` (agent edits this)     | Workspace files: AGENTS.md, SOUL.md, TOOLS.md, HEARTBEAT.md                        |
| `program.md` (human edits this)   | Agent: `.agents/auto-improve/AGENT.md` — research strategy                         |
| `val_bpb` metric                  | Composite score: delegation ratio, memory usage, conciseness, error rate           |
| `results.tsv`                     | `~/.openclaw/workspace/auto-improve/results.tsv`                                   |
| 5-min training run                | Analyze last N hours of real conversations                                         |

## 3. Heuristic Metrics

| Metric                    | Weight | Source                                                             | Good      | Bad        |
| ------------------------- | ------ | ------------------------------------------------------------------ | --------- | ---------- |
| Delegation ratio          | 0.30   | Count `sessions_spawn`/`message` vs `exec`/`mcp_search` tool calls | >0.5      | <0.2       |
| Memory usage rate         | 0.20   | Count `memory_search` calls vs context-trigger messages            | >0.8      | <0.3       |
| Conciseness               | 0.15   | Average response word count for simple queries                     | <80 words | >200 words |
| Silent reply accuracy     | 0.15   | Correct `NO_REPLY` for off-channel messages                        | >0.9      | <0.5       |
| Tool error rate (inverse) | 0.20   | Count `is_error` in tool results                                   | <0.05     | >0.2       |

## 4. File Access Rules

| File                 | Access       | Reason                                         |
| -------------------- | ------------ | ---------------------------------------------- |
| `AGENTS.md`          | Read + Write | Primary prompt file — routing rules, protocols |
| `SOUL.md`            | Read + Write | Identity and behavior rules                    |
| `TOOLS.md`           | Read + Write | Tool guidance and delegation rules             |
| `HEARTBEAT.md`       | Read + Write | Proactive behavior rules                       |
| `MEMORY.md`          | Read ONLY    | Contains personal data — never modify          |
| `IDENTITY.md`        | Read ONLY    | System-critical — never modify                 |
| Source code (`src/`) | NEVER        | Fixed infrastructure, like `prepare.py`        |

## 5. Division: Agent vs Skill

**Agent (`.agents/auto-improve/AGENT.md`)** — the researcher:

- Strategy for analyzing logs and identifying weaknesses
- Decision-making: which file to edit, what change to try
- Experiment loop: edit → commit → wait → re-score → keep/discard
- You iterate on this file to make it a better researcher

**Skill (`skills/auto-improve/SKILL.md`)** — the eval harness:

- JSONL log parsing schema (toolCall format, entry types)
- Metric computation formulas
- Keep/discard thresholds
- File access rules (editable vs read-only)
- Results tracking format
- Fixed — not modified by the agent

## 6. System Overview

```mermaid
graph TB
    subgraph "User Interaction (Live)"
        U[User] -->|Telegram / Web Chat| OP1[Operator1 Agent<br/>GLM-5]
        OP1 -->|writes| LOGS[(Session Logs<br/>~/.openclaw/agents/main/sessions/*.jsonl)]
        OP1 -->|reads at session start| WF[Workspace Files<br/>AGENTS.md, SOUL.md,<br/>TOOLS.md, HEARTBEAT.md]
    end

    subgraph "Auto-Improve Agent (Claude Code)"
        AI[Auto-Improve Agent<br/>.agents/auto-improve/AGENT.md] -->|1. reads| LOGS
        AI -->|2. scores using| SKILL[Eval Harness<br/>skills/auto-improve/SKILL.md]
        SKILL -->|metrics| SCORE{Composite<br/>Score}
        SCORE -->|improved| KEEP[Keep: git commit stays]
        SCORE -->|worse| REVERT[Discard: git reset]
        KEEP --> IDENTIFY[Identify weakest metric]
        REVERT --> IDENTIFY
        IDENTIFY -->|3. edits ONE file| WF
        AI -->|4. commits| GIT[(Git History<br/>~/.openclaw/workspace/)]
        AI -->|5. logs| RESULTS[results.tsv]
    end

    subgraph "Metrics (Eval Harness - Fixed)"
        M1[Delegation Ratio 0.30]
        M2[Memory Usage Rate 0.20]
        M3[Conciseness 0.15]
        M4[Silent Reply Accuracy 0.15]
        M5[Tool Error Rate 0.20]
    end

    SKILL --- M1 & M2 & M3 & M4 & M5

    style OP1 fill:#f9d71c,stroke:#333
    style AI fill:#4a9eff,stroke:#333
    style SKILL fill:#ff6b6b,stroke:#333,color:#fff
    style WF fill:#51cf66,stroke:#333
    style LOGS fill:#845ef7,stroke:#333,color:#fff
```

```mermaid
sequenceDiagram
    participant U as User
    participant OP as Operator1 (GLM-5)
    participant L as Session Logs
    participant AI as Auto-Improve Agent
    participant S as Eval Harness (Skill)
    participant W as Workspace Files
    participant G as Git

    Note over U,OP: Normal conversation happening
    U->>OP: Messages via Telegram/Web
    OP->>L: Writes session JSONL
    OP->>U: Responds

    Note over AI,S: Auto-improve cycle (parallel)
    AI->>L: 1. Read last N sessions
    AI->>S: 2. Compute metrics
    S-->>AI: Score: 0.65 (delegation=0.2, memory=0.8, ...)

    alt First run
        AI->>AI: Record as baseline
    else Score improved
        AI->>G: Keep commit
        AI->>AI: Log: keep
    else Score worsened
        AI->>G: git reset (revert)
        AI->>AI: Log: discard
    end

    AI->>AI: 3. Weakest metric: delegation (0.2)
    AI->>W: 4. Edit AGENTS.md routing rules
    AI->>G: 5. git commit

    Note over U,OP: Next session picks up changes
    U->>OP: New message
    OP->>W: Loads updated AGENTS.md
    OP->>U: Responds with improved routing

    AI->>L: Re-analyze new sessions...
    Note over AI: Loop continues
```

## 7. Experiment Loop

```
LOOP:
  1. Read last N sessions from ~/.openclaw/agents/main/sessions/*.jsonl
  2. Score each session against heuristic metrics
  3. Compute composite score
  4. If first run: record as baseline, continue
  5. Compare to previous score
  6. If improved: keep (git commit stays), log to results.tsv
  7. If worse: revert (git reset), log to results.tsv
  8. Identify weakest metric
  9. Propose ONE change to ONE workspace file targeting that weakness
  10. Edit file, git commit
  11. Wait for new conversations (or configurable interval)
  12. GOTO 1
```

## 8. Parallel Operation

Safe to run while user chats with Operator1 because:

- Workspace files loaded at session start — mid-session edits take effect on next session
- Session logs are append-only — concurrent read is safe
- Git operations isolated to workspace repo

## 9. Tasks

- [ ] **8.1** Create `.agents/auto-improve/AGENT.md` with experiment loop instructions
- [ ] **8.2** Create `skills/auto-improve/SKILL.md` with eval harness (metrics, parsing, thresholds)
- [ ] **8.3** Create scoring script or inline scoring logic for JSONL log analysis
- [ ] **8.4** Test: run agent, verify it can parse logs and compute baseline scores
- [ ] **8.5** Test: verify keep/discard cycle works with git commit/revert
- [ ] **8.6** Document in workspace README or TOOLS.md how to invoke the agent

## 10. Future Expansion (Out of Scope for v1)

- LLM-based response quality scoring (beyond heuristics)
- Auto-create new memory files or skills
- Multi-agent coordination (auto-improve Neo/Morpheus/Trinity too)
- Cron-based fully autonomous loop (run overnight)
