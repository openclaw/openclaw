---
name: skill-creator
description: "Create, edit, improve, or audit AgentSkills (SKILL.md + scripts/ + references/ + examples/). Use when: creating a new skill, improving/reviewing/auditing/cleaning up an existing skill, restructuring skill directories. Triggers: 'create a skill', 'author a skill', 'tidy up a skill', 'improve this skill', 'review the skill', 'clean up the skill', 'audit the skill', '스킬 만들어', '스킬 개선', '스킬 수정'. NOT for: non-skill file edits."
---

# Skill Creator

Create and maintain AgentSkills — modular packages that extend agent capabilities with specialized knowledge, workflows, and tools.

## Skills 2.0 Directory Structure

```
skill-name/
├── SKILL.md          # Core instructions only (50-80 lines ideal)
├── scripts/          # Executable scripts (PowerShell, Python, bash)
├── references/       # Reference docs (detailed guides, catalogs)
└── examples/         # Example outputs (optional)
```

AgentSkills spec: https://agentskills.io/specification.md

## Core Principles

1. **Context window is shared** — Only add what the model doesn't already know. Challenge each paragraph: "Does this justify its token cost?"
2. **Progressive disclosure** — Metadata always loaded (~100 words) → SKILL.md on trigger (<5k words) → references/ on demand (unlimited)
3. **Concise over verbose** — Prefer examples over explanations. Target 50-80 lines for SKILL.md body.
4. **Match freedom to fragility** — Narrow bridge → specific guardrails (scripts); open field → high-level guidance (text)

## SKILL.md Structure

### Frontmatter (YAML, required)

- `name`: Skill name (lowercase, hyphens, <64 chars)
- `description`: **Primary trigger mechanism**. Include what + when + NOT for. All "when to use" info goes here (body loads after trigger).

### Body (Markdown, required)

Imperative form. Core workflow only. Move detailed content to `references/`.

## Bundled Resources

| Directory     | Purpose                      | When to include                                      |
| ------------- | ---------------------------- | ---------------------------------------------------- |
| `scripts/`    | Deterministic, reusable code | Same code rewritten repeatedly; reliability needed   |
| `references/` | Docs loaded into context     | Schemas, API docs, detailed guides, domain knowledge |
| `examples/`   | Example outputs              | When output format needs demonstration               |
| `assets/`     | Files used in output         | Templates, icons, fonts (not loaded into context)    |

**Do NOT include**: README.md, CHANGELOG.md, INSTALLATION_GUIDE.md, or auxiliary docs.

## Creation Workflow

1. **Understand** — Gather concrete usage examples. Ask: "What triggers this? What does it do?"
2. **Plan** — Identify reusable resources (scripts, references, assets) from examples
3. **Init** — `scripts/init_skill.py <name> --path <dir> [--resources scripts,references]`
4. **Edit** — Implement resources, write SKILL.md. Test scripts by running them.
5. **Package** — `scripts/package_skill.py <path/to/skill-folder>` (validates + creates .skill)
6. **Iterate** — Use on real tasks, notice gaps, improve

For detailed design patterns (workflows, progressive disclosure, output formats), see [references/design-patterns.md](references/design-patterns.md).
