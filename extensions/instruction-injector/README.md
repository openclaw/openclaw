# Instruction Injector Plugin

Inject custom instructions into every agent session via the system prompt.

## Use Cases

- **Custom protocols** — Task tracking, code review requirements, etc.
- **Team guidelines** — Company-specific rules and processes
- **Project context** — Ongoing project information
- **Safety/compliance** — Required disclaimers or restrictions

## Installation

```json
{
  "plugins": {
    "entries": {
      "instruction-injector": {
        "enabled": true,
        "instructions": "Your custom instructions here..."
      }
    }
  }
}
```

## Configuration

### Inline Instructions

```json
{
  "plugins": {
    "entries": {
      "instruction-injector": {
        "enabled": true,
        "instructions": "## My Protocol\n\nAlways do X before Y.\nNever do Z without approval."
      }
    }
  }
}
```

### File-Based Instructions

```json
{
  "plugins": {
    "entries": {
      "instruction-injector": {
        "enabled": true,
        "file": "~/.openclaw/my-instructions.md"
      }
    }
  }
}
```

File takes precedence over inline if both are specified.

### Options

| Option           | Type                      | Default                 | Description                           |
| ---------------- | ------------------------- | ----------------------- | ------------------------------------- |
| `instructions`   | string                    | —                       | Inline instructions to inject         |
| `file`           | string                    | —                       | Path to markdown file (supports `~/`) |
| `position`       | `"prepend"` \| `"append"` | `"prepend"`             | Where to inject (prepend currently)   |
| `wrapWithHeader` | boolean                   | `true`                  | Wrap with `## Header`                 |
| `headerTitle`    | string                    | `"Custom Instructions"` | Header title if wrapping              |

## Example: Team Guidelines

**~/.openclaw/team-guidelines.md:**

```markdown
## Team Guidelines

1. All code changes require PR review
2. Use conventional commits (feat:, fix:, docs:, etc.)
3. Update tests when modifying behavior
4. No direct commits to main branch
```

**Config:**

```json
{
  "plugins": {
    "entries": {
      "instruction-injector": {
        "enabled": true,
        "file": "~/.openclaw/team-guidelines.md",
        "wrapWithHeader": false
      }
    }
  }
}
```

## Combining with Other Plugins

Use alongside other plugins for layered enforcement:

```json
{
  "plugins": {
    "entries": {
      "instruction-injector": {
        "enabled": true,
        "file": "~/.openclaw/my-protocol.md"
      },
      "audit-logger": { "enabled": true },
      "response-verifier": { "enabled": true }
    }
  }
}
```

- **instruction-injector** — Tells the agent what to do
- **audit-logger** — Records what it actually did
- **response-verifier** — Verifies claims before delivery

## Related

- **task-accountability** — GitHub issue enforcement (includes its own instruction injection)
- **audit-logger** — Audit trail for verification
- **response-verifier** — Completion claim verification
