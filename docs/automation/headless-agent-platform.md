---
summary: "Expose repeatable work as CLI/workflow/browser capabilities with deterministic agent scripts and review gates"
read_when:
  - Turning a repo into agent infrastructure
  - Designing surface-independent automation
  - Adding lifecycle checks for agent workflows
title: "Headless Agent Platform"
---

# Headless Agent Platform

Agent-ready platforms expose capabilities directly instead of burying them behind
manual UI paths. For OpenClaw, use three surfaces for the same work:

- CLI scripts for deterministic local execution
- workflow prompts for agent orchestration
- browser flows for real UI automation and artifacts

Generate the registry:

```bash
pnpm headless:registry
```

Validate deterministic agent behavior:

```bash
pnpm agent-script:check -- --file automation/agent-scripts/human-checkpoint-review.json
```

## Design Rules

- Separate the task from the surface where it appears.
- Prefer API/CLI/MCP-style entry points over click-only workflows.
- Model customer-facing/external-state work as static graphs with approval gates.
- Let employee-facing research/coding work use dynamic loops, but keep human review before shipping.
- Version capability registries and agent scripts so diffs are reviewable.
- Add evals or scoring criteria before re-enabling scheduled work.
