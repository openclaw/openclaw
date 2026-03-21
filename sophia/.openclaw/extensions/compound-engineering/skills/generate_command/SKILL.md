---
name: generate_command
description: Create a new custom slash command following conventions and best practices
argument-hint: "[command purpose and requirements]"
disable-model-invocation: true
---

# Create a Custom Claude Code Command

Create a new skill in `.openclaw/skills/` for the requested task.

## Goal

#$ARGUMENTS

## Key Capabilities to Leverage

**File Operations:**
- Read, Edit, Write - modify files precisely
- Glob, Grep - search codebase
- MultiEdit - atomic multi-part changes

**Development:**
- Bash - run commands (git, tests, linters)
- Task - launch specialized agents for complex tasks
- TodoWrite - track progress with todo lists

**Web & APIs:**
- WebFetch, WebSearch - research documentation
- GitHub (gh cli) - PRs, issues, reviews
- Playwright - browser automation, screenshots

**Integrations:**
- AppSignal - logs and monitoring
- Context7 - framework docs
- Stripe, Todoist, Featurebase (if relevant)

## Best Practices

1. **Be specific and clear** - detailed instructions yield better results
2. **Break down complex tasks** - use step-by-step plans
3. **Use examples** - reference existing code patterns
4. **Include success criteria** - tests pass, linting clean, etc.
5. **Think first** - use "think hard" or "plan" keywords for complex problems
6. **Iterate** - guide the process step by step

## Required: YAML Frontmatter

**EVERY command MUST start with YAML frontmatter:**

```yaml
---
name: command-name
description: Brief description of what this command does (max 100 chars)
argument-hint: "[what arguments the command accepts]"
---
```

**Fields:**
- `name`: Lowercase command identifier (used internally)
- `description`: Clear, concise summary of command purpose
- `argument-hint`: Shows user what arguments are expected (e.g., `[file path]`, `[PR number]`, `[optional: format]`)

## Structure Your Command

```markdown
# [Command Name]

[Brief description of what this command does]

## Steps

1. [First step with specific details]
   - Include file paths, patterns, or constraints
   - Reference existing code if applicable

2. [Second step]
   - Use parallel tool calls when possible
   - Check/verify results

3. [Final steps]
   - Run tests
   - Lint code
   - Commit changes (if appropriate)

## Success Criteria

- [ ] Tests pass
- [ ] Code follows style guide
- [ ] Documentation updated (if needed)
```

## Tips for Effective Commands

- **Use $ARGUMENTS** placeholder for dynamic inputs
- **Reference AGENTS.md** patterns and conventions
- **Include verification steps** - tests, linting, visual checks
- **Be explicit about constraints** - don't modify X, use pattern Y
- **Use XML tags** for structured prompts: `<task>`, `<requirements>`, `<constraints>`

## Example Pattern

```markdown
Implement #$ARGUMENTS following these steps:

1. Research existing patterns
   - Search for similar code using Grep
   - Read relevant files to understand approach

2. Plan the implementation
   - Think through edge cases and requirements
   - Consider test cases needed

3. Implement
   - Follow existing code patterns (reference specific files)
   - Write tests first if doing TDD
   - Ensure code follows AGENTS.md conventions

4. Verify
   - Run tests: `bin/rails test`
   - Run linter: `bundle exec standardrb`
   - Check changes with git diff

5. Commit (optional)
   - Stage changes
   - Write clear commit message
```

## Creating the Command File

1. **Create the directory** at `.openclaw/skills/[name]/SKILL.md`
2. **Start with YAML frontmatter** (see section above)
3. **Structure the skill** using the template above
4. **Test the skill** by using it with appropriate arguments

## Command File Template

```markdown
---
name: command-name
description: What this command does
argument-hint: "[expected arguments]"
---

# Command Title

Brief introduction of what the command does and when to use it.

## Workflow

### Step 1: [First Major Step]

Details about what to do.

### Step 2: [Second Major Step]

Details about what to do.

## Success Criteria

- [ ] Expected outcome 1
- [ ] Expected outcome 2
```
