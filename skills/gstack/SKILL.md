---
name: gstack-workflow
description: Structured AI-assisted development workflow with specialist roles — Think, Plan, Build, Review, Test, Ship, Reflect. Adapted from garrytan/gstack (MIT).
metadata: { "openclaw": { "inject": true, "always": true, "emoji": "⚡" } }
---

# gstack — Structured Development Workflow

A process that turns AI into a virtual engineering team. Eighteen specialist roles, structured as a sprint: **Think → Plan → Build → Review → Test → Ship → Reflect**. Each skill feeds into the next.

Adapted from [garrytan/gstack](https://github.com/garrytan/gstack) (MIT License).

---

## Completeness Principle — Boil the Lake

AI-assisted coding makes the marginal cost of completeness near-zero. When presenting options:

- If Option A is complete (all edge cases, full coverage) and Option B is a shortcut — **always recommend A**.
- **Lake vs. ocean:** A "lake" is boilable — 100% test coverage for a module, full feature implementation, all edge cases. An "ocean" is not — multi-quarter migrations, rewriting dependencies. Recommend boiling lakes. Flag oceans as out of scope.
- Don't skip the last 10% to "save time" — with AI, that 10% costs seconds.

## Search Before Building

Before building infrastructure or unfamiliar patterns — **search first**.

**Three layers of knowledge:**
- **Layer 1** (tried and true): Don't reinvent the wheel.
- **Layer 2** (new and popular): Search for these, but scrutinize.
- **Layer 3** (first principles): Original observations from reasoning about the specific problem. The most valuable.

---

## Sprint Workflow

| Phase | Skill | Role | What it does |
|-------|-------|------|--------------|
| **Think** | [office-hours](office-hours/SKILL.md) | YC Office Hours | Forcing questions that reframe the product before code. Design doc feeds downstream. |
| **Plan** | [plan-ceo-review](plan-ceo-review/SKILL.md) | CEO / Founder | Rethink the problem. 10-star product. Four modes: Expansion, Selective, Hold, Reduction. |
| **Plan** | [plan-eng-review](plan-eng-review/SKILL.md) | Eng Manager | Lock architecture, data flow, diagrams, edge cases, tests. |
| **Plan** | [plan-design-review](plan-design-review/SKILL.md) | Senior Designer | Rate design dimensions 0-10, explain what a 10 looks like, edit the plan. |
| **Plan** | [design-consultation](design-consultation/SKILL.md) | Design Partner | Build a complete design system from scratch. |
| **Review** | [review](review/SKILL.md) | Staff Engineer | Find bugs that pass CI but blow up in production. Auto-fix obvious ones. |
| **Review** | [design-review](design-review/SKILL.md) | Designer Who Codes | Same audit as plan-design-review, then fixes what it finds. |
| **Debug** | [investigate](investigate/SKILL.md) | Debugger | Systematic root-cause debugging. No fixes without investigation. |
| **Test** | [qa](qa/SKILL.md) | QA Lead | Test the app, find bugs, fix with atomic commits, re-verify. |
| **Test** | [qa-only](qa-only/SKILL.md) | QA Reporter | Same methodology as qa, but report only — no code changes. |
| **Test** | [benchmark](benchmark/SKILL.md) | Performance Engineer | Page load times, Core Web Vitals, bundle sizes. Before/after on every PR. |
| **Ship** | [ship](ship/SKILL.md) | Release Engineer | Sync main, run tests, audit coverage, push, open PR. |
| **Ship** | [land-and-deploy](land-and-deploy/SKILL.md) | Release Engineer | Merge PR, wait for CI, deploy, verify production health. |
| **Ship** | [canary](canary/SKILL.md) | SRE | Post-deploy monitoring loop. Console errors, perf regressions, page failures. |
| **Reflect** | [retro](retro/SKILL.md) | Eng Manager | Weekly retro with per-person breakdowns, shipping streaks, test health. |
| **Reflect** | [document-release](document-release/SKILL.md) | Technical Writer | Update all docs to match what shipped. Catches stale READMEs. |

### Safety Tools

| Skill | What it does |
|-------|--------------|
| [careful](careful/SKILL.md) | Warn before destructive commands (rm -rf, DROP TABLE, force-push). |
| [freeze](freeze/SKILL.md) | Restrict edits to one directory to prevent accidental changes. |
| [guard](guard/SKILL.md) | Maximum safety: careful + freeze combined. |
| [unfreeze](unfreeze/SKILL.md) | Remove the freeze boundary. |

---

## Completion Status Protocol

When completing any skill workflow, report status using one of:
- **DONE** — All steps completed successfully. Evidence provided.
- **DONE_WITH_CONCERNS** — Completed, but with issues to flag.
- **BLOCKED** — Cannot proceed. State what's blocking and what was tried.
- **NEEDS_CONTEXT** — Missing information required to continue.

### Escalation

It is always OK to stop and say "this is too hard" or "I'm not confident in this result."

- If you have attempted a task 3 times without success, STOP and escalate.
- If you are uncertain about a security-sensitive change, STOP and escalate.

---

## Suggesting Skills

When you notice the user is at a particular stage, suggest the appropriate skill:

- Brainstorming a new idea → suggest office-hours
- Reviewing a plan (strategy) → suggest plan-ceo-review
- Reviewing a plan (architecture) → suggest plan-eng-review
- Reviewing a plan (design) → suggest plan-design-review
- Creating a design system → suggest design-consultation
- Debugging errors → suggest investigate
- Testing the app → suggest qa
- Code review before merge → suggest review
- Visual design audit → suggest design-review
- Ready to deploy / create PR → suggest ship
- Post-ship doc updates → suggest document-release
- Weekly retrospective → suggest retro
- Working with production or live systems → suggest careful

All child skills are seeded into the workspace alongside this parent skill and can be read at `{{WORKSPACE_PATH}}/skills/gstack/<child>/SKILL.md`.
