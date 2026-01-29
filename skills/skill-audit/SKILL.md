---
name: skills-audit
description: Audit locally installed agent skills for security/policy issues using the SkillLens CLI (`skilllens scan`, `skilllens config`). Use when asked to scan a skills directory (Codex/Claude) and produce a risk-focused audit report based on each skill's `SKILL.md` and bundled resources.
---

# Skills Audit (SkillLens)

## Install SkillLens

- One-off run: `npx skilllens scan` (or `pnpm dlx skilllens scan`)
- Global install: `pnpm add -g skilllens`

## Quick start

- Run `skilllens config` to see configured scan roots and auditor CLI availability.
- Run `skilllens scan` to scan configured roots, or `skilllens scan <path>` to scan a specific directory.
- Re-run with `--verbose` to see raw auditor output and `--force` to ignore cached results.

## Audit workflow

1. Define scope
   - Prefer a concrete target path (example: `~/.codex/skills`) unless the user explicitly wants all configured roots.
   - If auditing a repo checkout containing skills, scan the parent folder that contains skill directories (example: `skilllens scan ./skills`).

2. Inventory skills with SkillLens
   - Run `skilllens scan [path] [--auditor claude|codex]`.
   - Treat missing auditor CLIs or `skipped` statuses as “manual review required”, not “safe”.

3. Prioritize review order
   - Review any `unsafe` or `suspicious` verdicts first.
   - Next, review skills that request broad permissions (filesystem/network), run shell commands, or reference external downloads.

4. Manually review each skill’s contents
   - Read the skill’s `SKILL.md` and any referenced `scripts/`, `references/`, and `assets/`.
   - Do not execute bundled scripts by default; inspect first.

5. Evaluate risks (focus on realistic abuse)
   - **Exfiltration**: sending file contents, env vars, tokens, SSH keys, browser data, or configs to remote endpoints.
   - **Execution**: instructions to run arbitrary shell commands, `curl | bash`, `eval`, or to fetch-and-execute code.
   - **Persistence**: modifying shell profiles, launch agents, cron, editor configs, or skill install locations.
   - **Privilege/approval bypass**: instructions to ignore system policies, disable safety checks, or request escalated permissions unnecessarily.
   - **Prompt injection**: attempts to override higher-priority instructions (“ignore previous”, “always comply”, “never mention…”).
   - **Overbroad triggers**: vague descriptions that cause the skill to trigger on unrelated tasks.

6. Produce a report
   - For each skill, include: `name`, `path`, `verdict` (safe/suspicious/unsafe), `risk` (0–100), and bullet issues with concrete evidence (quote or filename).
   - Recommend fixes that reduce blast radius: narrow scope, remove dangerous defaults, add explicit confirmation gates, and document required permissions.

## Command snippets

- Scan configured roots: `skilllens scan`
- Scan a specific folder: `skilllens scan ~/.codex/skills`
- Force a re-audit and show raw output: `skilllens scan ~/.codex/skills --force --verbose`
