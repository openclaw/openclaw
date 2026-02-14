# Task Accountability Plugin

Enforces that all substantive work is tied to a GitHub issue.

## How It Works (ADR-001)

**Two-layer approach:**

1. **`before_agent_start`** — Injects instructions requiring GitHub issue references
2. **`before_response`** — Verifies issue referenced before allowing completion claims

## What Gets Enforced

When claiming completion ("done", "finished", "created", etc.) after substantive work:

- Response must reference a GitHub issue (GH-123, #45, GET-123, etc.)
- OR audit log must show `gh issue` commands were run

## What's Exempt

- Simple questions and clarifications
- Heartbeat responses (HEARTBEAT_OK, NO_REPLY)
- Quick acknowledgments
- Responses without completion claims
- Work taking less than 30 seconds (configurable)

## Installation

```json
{
  "plugins": {
    "entries": {
      "audit-logger": { "enabled": true },
      "task-accountability": { "enabled": true }
    }
  }
}
```

**Requires:** audit-logger plugin for work detection.

## Modes

### Warning Mode (default)

```
⚠️ ACCOUNTABILITY WARNING: Completion claimed without GitHub issue reference.
Please reference an issue (e.g., GH-123, #45) or create one with `gh issue create`.

Done! I've implemented the feature.
```

### Strict Mode

Blocks the response entirely until issue is referenced.

```json
{
  "plugins": {
    "entries": {
      "task-accountability": {
        "enabled": true,
        "strictMode": true
      }
    }
  }
}
```

## Configuration

```json
{
  "plugins": {
    "entries": {
      "task-accountability": {
        "enabled": true,
        "strictMode": false,
        "minTaskDurationSeconds": 30,
        "issuePatterns": ["PROJ-\\d+"],
        "exemptPatterns": ["status check"]
      }
    }
  }
}
```

| Option                   | Default | Description                                    |
| ------------------------ | ------- | ---------------------------------------------- |
| `strictMode`             | `false` | Block vs warn on missing issue                 |
| `minTaskDurationSeconds` | `30`    | Only require issues for longer tasks           |
| `issuePatterns`          | `[]`    | Additional regex patterns for issue references |
| `exemptPatterns`         | `[]`    | Additional patterns for exempt responses       |

## Issue Reference Formats

Recognized automatically:

- `GH-123`, `#123`, `issue #123`
- `github.com/org/repo/issues/123`
- `GET-123`, `ABC-123` (Linear-style)

## Injected Instructions

The plugin injects this into every system prompt:

```
## Task Accountability Protocol

MANDATORY: All substantive work must be tied to a GitHub issue.

Before starting work that involves:
- Creating or modifying files
- Running commands that change state
- Sending messages on behalf of the user
- Any task expected to take more than 30 seconds

You MUST:
1. Reference an existing issue (e.g., "Working on GH-123")
2. OR create a new issue first (`gh issue create`)

When claiming completion:
- Reference the issue in your response
- The system will verify this before delivering your response
```

## Related

- **ADR-001:** `docs/adr/ADR-001-task-verification.md`
- **audit-logger:** Required for work detection
- **response-verifier:** Complementary general verification
