# Common Pitfalls in Skill Development

This document catalogs common issues that developers encounter when creating skills for OpenClaw.

## YAML Frontmatter Issues

### Unquoted Colons in Description Field

**Problem:** Skills with unquoted colons in the `description` field fail to load silently due to YAML parser errors.

**Error Message:**
```
Nested mappings are not allowed in compact mappings
```

**Root Cause:** YAML treats unquoted colons as key-value separators. The colon (`:`) is interpreted as a delimiter, not as part of the string.

**Broken Example:**
```yaml
---
name: my-skill
description: Use when you need to: do something important
---
```

**Fixed Example:**
```yaml
---
name: my-skill
description: "Use when you need to: do something important"
---
```

**Detection Difficulty:**
- `package_skill.py` validates and packages successfully
- Skills appear in workspace directory
- No runtime errors visible to user
- Skills simply don't appear in loaded skills list
- Required OpenClaw restart + new session to test

**Best Practice:** Always quote strings in YAML frontmatter that contain:
- Colons (`:`)
- Special characters (`*`, `#`, `|`, `>`)
- Strings starting/ending with spaces

---

## SKILL.md Body Issues

### Excessive Verbosity

**Problem:** SKILL.md files that are too long consume excessive context window.

**Solution:** Use the progressive disclosure pattern:
- Keep SKILL.md body under 500 lines
- Move detailed reference material to `references/` directory
- Link to reference files from SKILL.md body

### Missing Trigger Examples

**Problem:** Skills with vague descriptions don't get triggered appropriately.

**Solution:** Include specific phrases in the `description` field:
```yaml
description: "Create, edit, or improve AgentSkills. Triggers on: create a skill, improve this skill, tidy up skill, audit skill"
```

---

## Bundle Resource Issues

### Large Reference Files

**Problem:** Loading large reference files into context unnecessarily.

**Solution:** For files over 10k words, include grep search patterns in SKILL.md to help Codex find relevant sections.

### Missing Script Executability

**Problem:** Scripts in `scripts/` directory not being executed properly.

**Solution:** Ensure scripts have proper shebang (`#!/bin/bash`, `#!/usr/bin/env python3`) and execute permissions.

---

## Testing Issues

### Skills Not Appearing After Restart

**Common Causes:**
1. YAML frontmatter parsing errors (see: Unquoted Colons)
2. Invalid YAML syntax
3. Missing required fields (`name`, `description`)
4. File in wrong location (must be in `skills/<skill-name>/SKILL.md`)

**Debugging Steps:**
1. Check OpenClaw logs for YAML parsing errors
2. Validate YAML with `python3 -c "import yaml; yaml.safe_load(open('SKILL.md'))"`
3. Verify skill directory structure matches specification
4. Ensure no symlinks (security restriction)

---

*Last updated: 2026-03-15*
