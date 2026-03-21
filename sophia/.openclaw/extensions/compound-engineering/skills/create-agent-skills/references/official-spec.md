# Official Skill Specification (2026)

Source: [code.claude.com/docs/en/skills](https://code.claude.com/docs/en/skills)

## Commands and Skills Are Merged

Custom slash commands have been merged into skills. A file at `.openclaw/commands/review.md` and a skill at `.openclaw/skills/review/SKILL.md` both create `/review` and work the same way. Existing `.openclaw/commands/` files keep working. Skills add optional features: a directory for supporting files, frontmatter to control invocation, and automatic context loading.

If a skill and a command share the same name, the skill takes precedence.

## SKILL.md File Structure

Every skill requires a `SKILL.md` file with YAML frontmatter followed by standard markdown instructions.

```markdown
---
name: your-skill-name
description: What it does and when to use it
---

# Your Skill Name

## Instructions
Clear, step-by-step guidance.

## Examples
Concrete examples of using this skill.
```

## Complete Frontmatter Reference

All fields are optional. Only `description` is recommended.

| Field | Required | Description |
|-------|----------|-------------|
| `name` | No | Display name. Lowercase letters, numbers, hyphens only (max 64 chars). Defaults to directory name if omitted. |
| `description` | Recommended | What it does AND when to use it (max 1024 chars). Claude uses this to decide when to apply the skill. |
| `argument-hint` | No | Hint shown during autocomplete. Example: `[issue-number]` or `[filename] [format]` |
| `disable-model-invocation` | No | Set `true` to prevent Claude from auto-loading. Use for manual workflows. Default: `false` |
| `user-invocable` | No | Set `false` to hide from `/` menu. Use for background knowledge. Default: `true` |
| `allowed-tools` | No | Tools Claude can use without permission prompts. Example: `Read, Bash(git *)` |
| `model` | No | Model to use: `haiku`, `sonnet`, or `opus` |
| `context` | No | Set `fork` to run in isolated subagent context |
| `agent` | No | Subagent type when `context: fork`. Options: `Explore`, `Plan`, `general-purpose`, or custom agent name |
| `hooks` | No | Hooks scoped to this skill's lifecycle |

## Invocation Control

| Frontmatter | User can invoke | Claude can invoke | When loaded into context |
|-------------|----------------|-------------------|--------------------------|
| (default) | Yes | Yes | Description always in context, full skill loads when invoked |
| `disable-model-invocation: true` | Yes | No | Description not in context, full skill loads when you invoke |
| `user-invocable: false` | No | Yes | Description always in context, full skill loads when invoked |

## Skill Locations & Priority

```
Enterprise (highest priority) → Personal → Project → Plugin (lowest priority)
```

| Type | Path | Applies to |
|------|------|-----------|
| Enterprise | See managed settings | All users in organization |
| Personal | `~/.openclaw/skills/<name>/SKILL.md` | You, across all projects |
| Project | `.openclaw/skills/<name>/SKILL.md` | Anyone working in repository |
| Plugin | `<plugin>/skills/<name>/SKILL.md` | Where plugin is enabled |

Plugin skills use a `plugin-name:skill-name` namespace, so they cannot conflict with other levels.

## How Skills Work

1. **Discovery**: Claude loads only name and description at startup (2% of context window budget)
2. **Activation**: When your request matches a skill's description, Claude loads the full content
3. **Execution**: Claude follows the skill's instructions

## String Substitutions

| Variable | Description |
|----------|-------------|
| `$ARGUMENTS` | All arguments passed when invoking |
| `$ARGUMENTS[N]` | Specific argument by 0-based index |
| `$N` | Shorthand for `$ARGUMENTS[N]` |
| `${CLAUDE_SESSION_ID}` | Current session ID |

## Dynamic Context Injection

The `` !`command` `` syntax runs shell commands before content is sent to Claude:

```markdown
## Context
- Current branch: !`git branch --show-current`
- PR diff: !`gh pr diff`
```

Commands execute immediately and their output replaces the placeholder. Claude only sees the final result.

## Progressive Disclosure

```
my-skill/
├── SKILL.md           # Entry point (required)
├── reference.md       # Detailed docs (loaded when needed)
├── examples.md        # Usage examples (loaded when needed)
└── scripts/
    └── helper.py      # Utility script (executed, not loaded)
```

Keep SKILL.md under 500 lines. Link to supporting files:
```markdown
For API details, see [reference.md](reference.md).
```

## Running in a Subagent

Add `context: fork` to run in isolation:

```yaml
---
name: deep-research
description: Research a topic thoroughly
context: fork
agent: Explore
---

Research $ARGUMENTS thoroughly...
```

The skill content becomes the subagent's prompt. It won't have access to conversation history.

## Distribution

- **Project skills**: Commit `.openclaw/skills/` to version control
- **Plugins**: Add `skills/` directory to plugin
- **Enterprise**: Deploy organization-wide through managed settings
