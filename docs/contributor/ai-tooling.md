---
summary: "Contributor guidance for AI coding tools in clawdbot — root adapters, docs rules, build/test commands, workflow gate, and safety guardrails"
read_when:
  - "editing clawdbot with Claude, Codex, Gemini, or a local LLM"
  - "deciding where repo-root instructions end and workspace templates begin"
  - "looking up build/test commands or multi-agent safety rules"
---

# AI Tooling Contributor Guide

## Root adapters vs workspace templates

- Root `AGENTS.md`, `CLAUDE.md`, and `GEMINI.md` are **repo boot adapters**.
- `docs/reference/AGENTS.default.md` and `docs/reference/templates/AGENTS.md` are **workspace-agent templates** for OpenClaw runtime workspaces.
- Do not confuse repo-root tool adapters with workspace bootstrap files.

## Core guardrails

- Use repo-root-relative file references in replies; do not use absolute paths.
- For GitHub issue/PR comments with code or shell-sensitive content, use heredocs rather than escaped `\n` strings.
- Read `SECURITY.md` before security advisory triage.
- Do not edit generated `docs/zh-CN/**` content unless explicitly asked.
- Do not edit `node_modules` or rely on git stash/worktree/branch changes unless explicitly requested.
- Do not send streaming or partial replies to external messaging surfaces.

## Docs conventions

- Docs are Mintlify-driven.
- Use root-relative doc links without `.md` / `.mdx`.
- Use full `https://docs.openclaw.ai/...` URLs in user-facing replies when linking docs.
- Keep docs generic: no personal machine names or private paths in published docs.

## Build, test, and dev commands

```bash
pnpm install
pnpm build
pnpm check
pnpm test
pnpm test:coverage
pnpm openclaw ...
```

Use Bun-compatible execution where the repo already expects it, but keep Node 22+ compatibility intact.

## Workflow gate

For non-trivial coding work:

- create and approve `.workflow/prd.md`
- create and approve `.workflow/plan.md`
- use `rp-cli` / RepoPrompt for ANCHOR and REVIEW when available
- follow `ANCHOR -> EXECUTE -> REVIEW -> TEST -> GATE`

Canonical workflow source: `/Users/lionheart/clawd/workflows/cody/cody_Workflow-SKILL.md`

## Multi-agent safety

- Focus on your own files and avoid cross-cutting git state changes.
- Do not use stash/worktree/branch changes unless explicitly asked.
- Keep streaming/internal tool output off external messaging surfaces.
- Coordinate when touching shared files like dependency manifests, shared types, or registries.

## Related docs

- `docs/concepts/context.md`
- `docs/concepts/multi-agent.md`
- `docs/start/docs-directory.md`
- `docs/reference/AGENTS.default.md`
- `docs/reference/templates/AGENTS.md`
