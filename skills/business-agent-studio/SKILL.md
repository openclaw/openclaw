---
name: business-agent-studio
description: Use when designing reusable, sellable business agents or Claude/OpenClaw skills that turn raw inputs into reviewable assets such as research briefs, scripts, posts, outreach drafts, reports, or client automation packs. Enforces clear inputs, outputs, pricing logic, and human checkpoints before publishing or external actions.
---

# Business Agent Studio

Use this skill to package a workflow as a repeatable business agent.

## Workflow

1. Define the recurring job the agent replaces.
2. List required inputs, data sources, and client context.
3. Define outputs as reviewable files, not public actions.
4. Add a pricing band based on avoided labor or revenue impact.
5. Add checkpoints for publishing, outbound messages, CRM writes, spending, credentials, and deployment.
6. Produce a dated review folder with deliverables and an approval checklist.

## High-ROI Agent Patterns

- Content studio: topic plus references to scripts, posts, thumbnails, and infographic briefs.
- Research briefing: watchlist to cited daily or weekly opportunity report.
- Sales ops: lead list and ICP to qualification notes and outreach drafts.
- Reporting analyst: raw exports to executive summary, anomalies, and next actions.
- Workflow maintainer: repo or SaaS state to bugfix plan, PR draft, and test evidence.

## Rules

- Sell recurring outcomes, not generic chat access.
- Keep client secrets out of skill files and prompts.
- Prefer connectors and structured APIs over browser automation when available.
- Browser automation must leave screenshots/traces when used.
- Public posting, outbound messages, CRM writes, deploys, billing changes, and credential edits require human approval.
