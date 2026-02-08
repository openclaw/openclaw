# Skill Template

Template for creating skills extracted from learnings. Copy and customize.

---

## SKILL.md Template

```markdown
---
name: skill-name-here
description: "Concise description of when and why to use this skill. Include trigger conditions."
---

# Skill Name

Brief introduction explaining the problem this skill solves and its origin.

## Quick Reference

| Situation | Action |
|-----------|--------|
| [Trigger 1] | [Action 1] |
| [Trigger 2] | [Action 2] |

## Background

Why this knowledge matters. What problems it prevents. Context from the original learning.

## Solution

### Step-by-Step

1. First step with code or command
2. Second step
3. Verification step

### Code Example

\`\`\`language
// Example code demonstrating the solution
\`\`\`

## Common Variations

- **Variation A**: Description and how to handle
- **Variation B**: Description and how to handle

## Gotchas

- Warning or common mistake #1
- Warning or common mistake #2

## Related

- Link to related documentation
- Link to related skill

## Source

Extracted from learning entry.
- **Learning ID**: LRN-YYYYMMDD-XXX
- **Original Category**: correction | insight | knowledge_gap | best_practice
- **Extraction Date**: YYYY-MM-DD
```

---

## Minimal Template

For simple skills that don't need all sections:

```markdown
---
name: skill-name-here
description: "What this skill does and when to use it."
---

# Skill Name

[Problem statement in one sentence]

## Solution

[Direct solution with code/commands]

## Source

- Learning ID: LRN-YYYYMMDD-XXX
```

---

## Template with Scripts

For skills that include executable helpers:

```markdown
---
name: skill-name-here
description: "What this skill does and when to use it."
---

# Skill Name

[Introduction]

## Quick Reference

| Command | Purpose |
|---------|---------|
| `./scripts/helper.sh` | [What it does] |
| `./scripts/validate.sh` | [What it does] |

## Usage

### Automated (Recommended)

\`\`\`bash
./skills/skill-name/scripts/helper.sh [args]
\`\`\`

### Manual Steps

1. Step one
2. Step two

## Scripts

| Script | Description |
|--------|-------------|
| `scripts/helper.sh` | Main utility |
| `scripts/validate.sh` | Validation checker |

## Source

- Learning ID: LRN-YYYYMMDD-XXX
```

---

## Naming Conventions

- **Skill name**: lowercase, hyphens for spaces
  - Good: `docker-m1-fixes`, `api-timeout-patterns`
  - Bad: `Docker_M1_Fixes`, `APITimeoutPatterns`

- **Description**: Start with action verb, mention trigger
  - Good: "Handles Docker build failures on Apple Silicon. Use when builds fail with platform mismatch."
  - Bad: "Docker stuff"

- **Files**:
  - `SKILL.md` - Required, main documentation
  - `scripts/` - Optional, executable code
  - `references/` - Optional, detailed docs
  - `assets/` - Optional, templates

---

## Extraction Checklist

Before creating a skill from a learning:

- [ ] Learning is verified (status: resolved)
- [ ] Solution is broadly applicable (not one-off)
- [ ] Content is complete (has all needed context)
- [ ] Name follows conventions
- [ ] Description is concise but informative
- [ ] Quick Reference table is actionable
- [ ] Code examples are tested
- [ ] Source learning ID is recorded

After creating:

- [ ] Update original learning with `promoted_to_skill` status
- [ ] Add `Skill-Path: skills/skill-name` to learning metadata
- [ ] Test skill by reading it in a fresh session
