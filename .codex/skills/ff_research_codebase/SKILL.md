---
name: ff_research_codebase
description: Research and document the current codebase using Codex skills and subagents
---

# Research Codebase

Research the repository for the provided goal or question and write a concise, evidence-backed research document. Fastflow runs Codex with multi-agent support enabled by default, so use subagents for independent research slices when that will improve speed or coverage. Use repository-provided skills when relevant, and otherwise use normal Codex actions: read files, run commands, search with rg/find/git, and inspect local docs/history.

## Operating Rules

- Document what exists today. Do not implement changes during research.
- Read the goal and any directly referenced files before delegating.
- Prefer primary evidence from live files, tests, git history, and local docs.
- Use rg for text search and rg --files or find for file discovery.
- Use subagents only for bounded, independent research questions; do not delegate final synthesis.
- Ask subagents for concrete file paths, line references, commands run, and confidence/unknowns.
- If a useful Codex skill exists for the domain, invoke it with $skill_name or incorporate its guidance.
- If external systems such as Linear or GitHub are needed, use available skills or local CLI tools when authenticated; otherwise record what could not be checked.

## Subagent Pattern

When the goal has multiple independent research areas, spawn focused subagents such as:

- "Find the files and entry points related to {component}. Return paths, line references, and a short map. Do not edit files."
- "Inspect tests and validation commands for {feature}. Return existing patterns and recommended verification commands. Do not edit files."
- "Search thoughts/ and docs/ for prior decisions about {topic}. Return only relevant documents and summaries."

Continue local work while subagents run. Wait only when their findings are needed for synthesis. Cross-check important claims before writing the final artifact.

## Process

1. Read the goal or ticket content fully.
2. Identify likely research areas and decide which can run in parallel.
3. Spawn subagents for independent slices when useful; do local searches/read-throughs for the critical path.
4. Read the most relevant source, config, tests, and prior thoughts/research documents yourself.
5. Synthesize current behavior, constraints, entry points, and risks for the next stage.
6. Write a research artifact under thoughts/shared/research/.

## Artifact

Create a file named like:

`thoughts/shared/research/YYYY-MM-DD-{ticket-or-topic}.md`

Include:

```markdown
# Research: {topic}

## Summary

{short answer to the research question}

## Current Behavior

{what the system does today}

## Key Files

- `path/to/file.ext:line` - why it matters

## Relevant Tests Or Commands

- `command` - observed result or why it matters

## Constraints And Risks

{facts the plan/implementation must account for}

## Subagent Findings

{subagent summaries used, or "None"}

## Open Questions

{only questions that could not be answered from the repo}
```

## Completion

Finish by printing the research file path and a short summary of the most important findings.
