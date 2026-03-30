---
name: skill-creator
description: Create, edit, improve, or audit AgentSkills. Use when creating a new skill from scratch or when asked to improve, review, audit, tidy up, or clean up an existing skill or SKILL.md file. Also use when editing or restructuring a skill directory (moving files to references/ or scripts/, removing stale content, validating against the AgentSkills spec). Triggers on phrases like "create a skill", "author a skill", "tidy up a skill", "improve this skill", "review the skill", "clean up the skill", "audit the skill".
---

# Skill Creator

Skills are modular self-contained packages extending agent capabilities. They're "onboarding guides" for specific domains: specialized workflows, tool integrations, domain expertise, bundled resources.

For full design patterns and creation process, read `references/design-guide.md`.

## Core Principles

**Concise is key.** Context window is shared. Only add what the agent doesn't already know. Challenge each sentence: "Does this justify its token cost?"

**Progressive Disclosure** — 3 levels:
1. `name + description` — always in bootstrap (~100 words)
2. `SKILL.md body` — loaded on trigger (<500 lines target)
3. `references/`, `scripts/`, `assets/` — loaded as needed

**Match specificity to fragility**: high freedom (text) for heuristic tasks; low freedom (scripts) for fragile, sequenced ops.

## Skill Structure

```
skill-name/
├── SKILL.md (required)          ← frontmatter + lean instructions
└── references/                  ← loaded on demand
    scripts/                     ← executable, run without loading
    assets/                      ← output files (templates, images)
```

**No README, CHANGELOG, or auxiliary docs** — clutter only.

## SKILL.md Anatomy

**Frontmatter** (only `name` and `description` — no other fields):
- `description` is the trigger mechanism — include what it does AND when to use it, specific trigger phrases, "NOT for:" exclusions
- All "when to use" info goes here — not in the body (body loads after trigger)

**Body**: Instructions for the agent. Keep to essentials. Reference files for detail:
```markdown
For implementation patterns, read `references/patterns.md`.
```

## Creation Process

1. **Understand** — gather concrete usage examples, confirm trigger phrases
2. **Plan resources** — identify reusable scripts/references/assets from examples
3. **Initialize** — run `scripts/init_skill.py <name> --path <dir> [--resources ...]`
4. **Edit** — implement resources first, then write SKILL.md
5. **Package** — run `scripts/package_skill.py <path/to/skill-folder>`
6. **Iterate** — test on real tasks, refine

**Naming**: lowercase + hyphens, under 64 chars, verb-led, namespace by tool when helpful (e.g. `gh-address-comments`).

## Key Design Patterns

- Split SKILL.md when approaching 500 lines — move detail to `references/`
- Always reference split files from SKILL.md with clear "when to read" guidance
- For multi-variant skills: one reference file per variant (aws.md, gcp.md, azure.md)
- For large reference files (>100 lines): include table of contents at top
- Avoid nested references — all files link directly from SKILL.md

Read `references/design-guide.md` for workflow patterns, output patterns, and init/package script usage.
