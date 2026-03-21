# Skill Structure Reference

Skills have three structural components: YAML frontmatter (metadata), standard markdown body (content), and progressive disclosure (file organization).

## Body Format

Use **standard markdown headings** for structure. Keep markdown formatting within content (bold, italic, lists, code blocks, links).

```markdown
---
name: my-skill
description: What it does and when to use it
---

# Skill Name

## Quick Start
Immediate actionable guidance...

## Instructions
Step-by-step procedures...

## Examples
Concrete usage examples...

## Guidelines
Rules and constraints...
```

## Recommended Sections

Every skill should have:

- **Quick Start** - Immediate, actionable guidance (minimal working example)
- **Instructions** - Core step-by-step guidance
- **Success Criteria** - How to know it worked

Add based on complexity:

- **Context** - Background/situational information
- **Workflow** - Multi-step procedures
- **Examples** - Concrete input/output pairs
- **Advanced Features** - Deep-dive topics (link to reference files)
- **Anti-Patterns** - Common mistakes to avoid
- **Guidelines** - Rules and constraints

## YAML Frontmatter

### Required/Recommended Fields

```yaml
---
name: skill-name-here
description: What it does and when to use it (specific triggers included)
---
```

### Name Field

**Validation rules:**
- Maximum 64 characters
- Lowercase letters, numbers, hyphens only
- Must match directory name
- No reserved words: "anthropic", "claude"

**Examples:**
- `triage-prs`
- `deploy-production`
- `review-code`
- `setup-stripe-payments`

**Avoid:** `helper`, `utils`, `tools`, generic names

### Description Field

**Validation rules:**
- Maximum 1024 characters
- Include what it does AND when to use it
- Third person voice

**Good:**
```yaml
description: Extract text and tables from PDF files, fill forms, merge documents. Use when working with PDF files or when the user mentions PDFs, forms, or document extraction.
```

**Bad:**
```yaml
description: Helps with documents
```

### Optional Fields

| Field | Description |
|-------|-------------|
| `argument-hint` | Usage hints. Example: `[issue-number]` |
| `disable-model-invocation` | `true` to prevent auto-loading. Use for side-effect workflows. |
| `user-invocable` | `false` to hide from `/` menu. Use for background knowledge. |
| `allowed-tools` | Tools without permission prompts. Example: `Read, Bash(git *)` |
| `model` | `haiku`, `sonnet`, or `opus` |
| `context` | `fork` for isolated subagent execution |
| `agent` | Subagent type: `Explore`, `Plan`, `general-purpose`, or custom |

## Naming Conventions

Use descriptive names that indicate purpose:

| Pattern | Examples |
|---------|----------|
| Action-oriented | `triage-prs`, `deploy-production`, `review-code` |
| Domain-specific | `setup-stripe-payments`, `manage-facebook-ads` |
| Descriptive | `git-worktree`, `frontend-design`, `dhh-rails-style` |

## Progressive Disclosure

Keep SKILL.md under 500 lines. Split into reference files:

```
my-skill/
├── SKILL.md           # Entry point (required, overview + navigation)
├── reference.md       # Detailed docs (loaded when needed)
├── examples.md        # Usage examples (loaded when needed)
└── scripts/
    └── helper.py      # Utility script (executed, not loaded)
```

**Rules:**
- Keep references one level deep from SKILL.md
- Add table of contents to reference files over 100 lines
- Use forward slashes in paths: `scripts/helper.py`
- Name files descriptively: `form_validation_rules.md` not `doc2.md`

## Validation Checklist

Before finalizing:

- [ ] YAML frontmatter valid (name matches directory, description specific)
- [ ] Uses standard markdown headings (not XML tags)
- [ ] Has Quick Start, Instructions, and Success Criteria sections
- [ ] `disable-model-invocation: true` if skill has side effects
- [ ] SKILL.md under 500 lines
- [ ] Reference files linked properly from SKILL.md
- [ ] File paths use forward slashes
- [ ] Tested with real usage

## Anti-Patterns

- **XML tags in body** - Use standard markdown headings
- **Vague descriptions** - Be specific with trigger keywords
- **Deep nesting** - Keep references one level from SKILL.md
- **Missing invocation control** - Side-effect workflows need `disable-model-invocation: true`
- **Inconsistent naming** - Directory name must match `name` field
- **Windows paths** - Always use forward slashes
