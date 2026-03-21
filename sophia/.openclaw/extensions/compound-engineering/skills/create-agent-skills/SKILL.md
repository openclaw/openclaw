---
name: create-agent-skills
description: Expert guidance for creating Claude Code skills and slash commands. Use when working with SKILL.md files, authoring new skills, improving existing skills, creating slash commands, or understanding skill structure and best practices.
---

# Creating Skills & Commands

This skill teaches how to create effective Claude Code skills following the official specification from [code.claude.com/docs/en/skills](https://code.claude.com/docs/en/skills).

## Commands and Skills Are Now The Same Thing

Custom slash commands have been merged into skills. A file at `.openclaw/commands/review.md` and a skill at `.openclaw/skills/review/SKILL.md` both create `/review` and work the same way. Existing `.openclaw/commands/` files keep working. Skills add optional features: a directory for supporting files, frontmatter to control invocation, and automatic context loading.

**If a skill and a command share the same name, the skill takes precedence.**

## When To Create What

**Use a command file** (`commands/name.md`) when:
- Simple, single-file workflow
- No supporting files needed
- Task-oriented action (deploy, commit, triage)

**Use a skill directory** (`skills/name/SKILL.md`) when:
- Need supporting reference files, scripts, or templates
- Background knowledge Claude should auto-load
- Complex enough to benefit from progressive disclosure

Both use identical YAML frontmatter and markdown content format.

## Standard Markdown Format

Use YAML frontmatter + markdown body with **standard markdown headings**. Keep it clean and direct.

```markdown
---
name: my-skill-name
description: What it does and when to use it
---

# My Skill Name

## Quick Start
Immediate actionable guidance...

## Instructions
Step-by-step procedures...

## Examples
Concrete usage examples...
```

## Frontmatter Reference

All fields are optional. Only `description` is recommended.

| Field | Required | Description |
|-------|----------|-------------|
| `name` | No | Display name. Lowercase letters, numbers, hyphens (max 64 chars). Defaults to directory name. |
| `description` | Recommended | What it does AND when to use it. Claude uses this for auto-discovery. Max 1024 chars. |
| `argument-hint` | No | Hint shown during autocomplete. Example: `[issue-number]` |
| `disable-model-invocation` | No | Set `true` to prevent Claude auto-loading. Use for manual workflows like `/deploy`, `/commit`. Default: `false`. |
| `user-invocable` | No | Set `false` to hide from `/` menu. Use for background knowledge. Default: `true`. |
| `allowed-tools` | No | Tools Claude can use without permission prompts. Example: `Read, Bash(git *)` |
| `model` | No | Model to use. Options: `haiku`, `sonnet`, `opus`. |
| `context` | No | Set `fork` to run in isolated subagent context. |
| `agent` | No | Subagent type when `context: fork`. Options: `Explore`, `Plan`, `general-purpose`, or custom agent name. |

### Invocation Control

| Frontmatter | User can invoke | Claude can invoke | When loaded |
|-------------|----------------|-------------------|-------------|
| (default) | Yes | Yes | Description always in context, full content loads when invoked |
| `disable-model-invocation: true` | Yes | No | Description not in context, loads only when user invokes |
| `user-invocable: false` | No | Yes | Description always in context, loads when relevant |

**Use `disable-model-invocation: true`** for workflows with side effects: `/deploy`, `/commit`, `/triage-prs`, `/send-slack-message`. You don't want Claude deciding to deploy because your code looks ready.

**Use `user-invocable: false`** for background knowledge that isn't a meaningful user action: coding conventions, domain context, legacy system docs.

## Dynamic Features

### Arguments

Use `$ARGUMENTS` placeholder for user input. If not present in content, arguments are appended automatically.

```yaml
---
name: fix-issue
description: Fix a GitHub issue
disable-model-invocation: true
---

Fix GitHub issue $ARGUMENTS following our coding standards.
```

Access individual args: `$ARGUMENTS[0]` or shorthand `$0`, `$1`, `$2`.

### Dynamic Context Injection

Skills support dynamic context injection: prefix a backtick-wrapped shell command with an exclamation mark, and the preprocessor executes it at load time, replacing the directive with stdout. Write an exclamation mark immediately before the opening backtick of the command you want executed (for example, to inject the current git branch, write the exclamation mark followed by `git branch --show-current` wrapped in backticks).

**Important:** The preprocessor scans the entire SKILL.md as plain text — it does not parse markdown. Directives inside fenced code blocks or inline code spans are still executed. If a skill documents this syntax with literal examples, the preprocessor will attempt to run them, causing load failures. To safely document this feature, describe it in prose (as done here) or place examples in a reference file, which is loaded on-demand by Claude and not preprocessed.

For a concrete example of dynamic context injection in a skill, see [official-spec.md](references/official-spec.md) § "Dynamic Context Injection".

### Running in a Subagent

Add `context: fork` to run in isolation. The skill content becomes the subagent's prompt. It won't have conversation history.

```yaml
---
name: deep-research
description: Research a topic thoroughly
context: fork
agent: Explore
---

Research $ARGUMENTS thoroughly:
1. Find relevant files
2. Analyze the code
3. Summarize findings
```

## Progressive Disclosure

Keep SKILL.md under 500 lines. Split detailed content into reference files:

```
my-skill/
├── SKILL.md           # Entry point (required, overview + navigation)
├── reference.md       # Detailed docs (loaded when needed)
├── examples.md        # Usage examples (loaded when needed)
└── scripts/
    └── helper.py      # Utility script (executed, not loaded)
```

Link from SKILL.md: `For API details, see [reference.md](reference.md).`

Keep references **one level deep** from SKILL.md. Avoid nested chains.

## Effective Descriptions

The description enables skill discovery. Include both **what** it does and **when** to use it.

**Good:**
```yaml
description: Extract text and tables from PDF files, fill forms, merge documents. Use when working with PDF files or when the user mentions PDFs, forms, or document extraction.
```

**Bad:**
```yaml
description: Helps with documents
```

## What Would You Like To Do?

1. **Create new skill** - Build from scratch
2. **Create new command** - Build a slash command
3. **Audit existing skill** - Check against best practices
4. **Add component** - Add workflow/reference/example
5. **Get guidance** - Understand skill design

## Creating a New Skill or Command

### Step 1: Choose Type

Ask: Is this a manual workflow (deploy, commit, triage) or background knowledge (conventions, patterns)?

- **Manual workflow** → command with `disable-model-invocation: true`
- **Background knowledge** → skill without `disable-model-invocation`
- **Complex with supporting files** → skill directory

### Step 2: Create the File

**Command:**
```markdown
---
name: my-command
description: What this command does
argument-hint: [expected arguments]
disable-model-invocation: true
allowed-tools: Bash(gh *), Read
---

# Command Title

## Workflow

### Step 1: Gather Context
...

### Step 2: Execute
...

## Success Criteria
- [ ] Expected outcome 1
- [ ] Expected outcome 2
```

**Skill:**
```markdown
---
name: my-skill
description: What it does. Use when [trigger conditions].
---

# Skill Title

## Quick Start
[Immediate actionable example]

## Instructions
[Core guidance]

## Examples
[Concrete input/output pairs]
```

### Step 3: Add Reference Files (If Needed)

Link from SKILL.md to detailed content:
```markdown
For API reference, see [reference.md](reference.md).
For form filling guide, see [forms.md](forms.md).
```

### Step 4: Test With Real Usage

1. Test with actual tasks, not test scenarios
2. Invoke directly with `/skill-name` to verify
3. Check auto-triggering by asking something that matches the description
4. Refine based on real behavior

## Audit Checklist

- [ ] Valid YAML frontmatter (name + description)
- [ ] Description includes trigger keywords and is specific
- [ ] Uses standard markdown headings (not XML tags)
- [ ] SKILL.md under 500 lines
- [ ] `disable-model-invocation: true` if it has side effects
- [ ] `allowed-tools` set if specific tools needed
- [ ] References one level deep, properly linked
- [ ] Examples are concrete, not abstract
- [ ] Tested with real usage

## Anti-Patterns to Avoid

- **XML tags in body** - Use standard markdown headings
- **Vague descriptions** - Be specific with trigger keywords
- **Deep nesting** - Keep references one level from SKILL.md
- **Missing invocation control** - Side-effect workflows need `disable-model-invocation: true`
- **Too many options** - Provide a default with escape hatch
- **Punting to Claude** - Scripts should handle errors explicitly

## Reference Files

For detailed guidance, see:
- [official-spec.md](references/official-spec.md) - Official skill specification
- [best-practices.md](references/best-practices.md) - Skill authoring best practices

## Sources

- [Extend Claude with skills - Official Docs](https://code.claude.com/docs/en/skills)
- [GitHub - anthropics/skills](https://github.com/anthropics/skills)
