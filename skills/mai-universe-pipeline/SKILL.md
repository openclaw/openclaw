---
name: mai-universe-pipeline
description: "MAI Universe full-cycle pipeline — knowledge collection → opportunity discovery → project creation → development → deployment → contribution/revenue realization. Use when: pipeline review, new project opportunity evaluation, stage transitions, cross-project synergy analysis, revenue/contribution tracking. Triggers: 'MAI Universe', '파이프라인', '파이프라인 점검', '지식 수집', '기회 발견', '수익화', '기여', 'pipeline review', 'opportunity scan', 'monetization strategy'. NOT for: individual project dev tasks (use hybrid-coding), single project init (use mai-project-init), newsletter publishing (use maiupbit-newsletter)."
---

# MAI Universe Pipeline 🦞

> "Collect knowledge, discover value, realize as projects, contribute to the world while generating revenue."

6-stage automation pipeline for 지니's economic independence + social contribution.

## Pipeline Overview

```
COLLECT → DISCOVER → CREATE → BUILD → DEPLOY → REALIZE
  ↑                                              │
  └──────────── Feedback Loop ──────────────────┘
```

| Stage       | Description                                         | Automation |
| ----------- | --------------------------------------------------- | ---------- |
| 1. COLLECT  | Knowledge gathering (Mnemo, Brave, YouTube, GitHub) | ✅ Cron    |
| 2. DISCOVER | Opportunity detection via balance matrix scoring    | ✅ Partial |
| 3. CREATE   | Project init (mai-project-init skill)               | ✅ Auto    |
| 4. BUILD    | Development (MAIBOT direct + sub-agents)            | ✅ Auto    |
| 5. DEPLOY   | Launch to platforms (Railway/App Store/clawhub)     | 🔴 Manual  |
| 6. REALIZE  | Track contribution metrics + revenue KPIs           | 🔴 Manual  |

## Core Principle

> "Design structures that grow stronger with contributions and sustain through monetization."

Every opportunity is evaluated on the **Contribution-Revenue Balance Matrix**:

- 🟢 **Golden Zone**: Contribution + revenue in virtuous cycle (target)
- 🔵 **Seed**: Contribute first, revenue follows
- 🟡 **Pure Revenue**: Short-term OK, long-term fragile
- 🔴 **Avoid**: No value on either axis

## Key Commands

```powershell
# Full pipeline review
/파이프라인 점검

# Manual knowledge collection
cd C:\TEST\MAISECONDBRAIN; $env:PYTHONIOENCODING="utf-8"
python scripts/collect_knowledge.py

# New project (via mai-project-init)
/새 프로젝트 {name} "{description}"
```

## Opportunity Discovery Workflow

1. Record idea in `memory/`
2. Evaluate on contribution-revenue balance matrix
3. Cross-project synergy analysis (Mnemo cross-search)
4. Brief 지니 → approval
5. If approved → `mai-project-init` auto-execution

## Weekly Pipeline Review (Mon morning briefing)

- Each project's stage progress
- Bottleneck/blocking identification
- Contribution/revenue metric updates
- Next week priority suggestions

## References

- `references/pipeline-stages.md` — Detailed stage descriptions, commands, checklists
- `references/project-matrix.md` — Project status matrix, automation roadmap

---

_Pipeline version: v2.0 — Refactored 2026-03-13_
