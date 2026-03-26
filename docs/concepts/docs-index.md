---
summary: "Index of the highest-signal docs, plans, and debt ledgers for harness work"
read_when:
  - You need the shortest path to OpenClaw's key technical docs
  - You are onboarding an agent or teammate to harness/platform work
  - You need to know where plans and tech-debt records live
owner: "OpenClaw harness"
freshness: "monthly"
last_reviewed: "2026-03-25"
title: "Docs Index"
---

# Docs Index

This page is the shortest path to the repo knowledge OpenClaw expects humans and agents to use first.

## Core concepts

- [Agent Workspace](/concepts/agent-workspace)
- [System Prompt](/concepts/system-prompt)
- [Context](/concepts/context)
- [Harness Roadmap](/concepts/harness-roadmap)

## Harness governance

- [Standing Orders](/automation/standing-orders)
- [Hooks](/automation/hooks)
- [Harness Engineering checklist](/zh-CN/concepts/harness-engineering-checklist)
- [Anthropic long-running harness checklist](/zh-CN/concepts/anthropic-long-running-harness-checklist)

## Execution plans

- [Execution Plans index](/exec-plans/README)
- [Harness agent-first system plan](/exec-plans/harness-agent-first-system)
- [Role-scoped build loop](/exec-plans/role-scoped-build-loop)
- [Role-scoped build loop Phase 1 backlog](/exec-plans/role-scoped-build-loop-phase-1-backlog)

## Tech debt

- [Tech debt index](/tech-debt/README)
- [Harness platform gaps](/tech-debt/harness-platform-gaps)

## Maintenance rule

When a harness feature changes:

1. update the runtime docs in `concepts/` or `automation/`
2. update [Harness Roadmap](/concepts/harness-roadmap)
3. if it changes long-term direction, update an entry in `exec-plans/`
4. if it leaves a known gap or tradeoff, log it in `tech-debt/`
