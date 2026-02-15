---
name: poll-confirmation
description: Use when the user is deciding between clear options and normal clarification is stalling. Send a quick poll in the current chat using the message tool, then continue based on the user's selection.
---

# Poll Confirmation Skill

Use this skill only when all are true:

- The user needs to choose between options.
- Options can be written as short labels.
- A normal text clarification did not produce a clear choice.

## Workflow

1. Ask once in plain text for the user's preference.
2. If still unclear, send a poll in the same chat with `message` tool.
3. Keep options short and mutually exclusive where possible.
4. After the user responds, continue with that choice.

## Tool Call Pattern

Use `message` tool with:

- `action: "poll"`
- `pollQuestion`
- `pollOption` (2-5 options preferred)
- `target` omitted when the current session target should be used
- `channel` only if required by context

Telegram-specific optional fields:

- `pollPublic: true` for non-anonymous
- `pollAnonymous: true` for anonymous
- `pollDurationSeconds` (Telegram supports 5-600)

## Example

```json
{
  "action": "poll",
  "pollQuestion": "Which plan should I use?",
  "pollOption": ["Basic", "Pro"],
  "pollPublic": true
}
```

## Guardrails

- Do not send multiple polls in a row for the same unresolved question.
- Do not use polls for sensitive/high-risk decisions (legal, medical, financial authority decisions).
- If poll delivery fails, fall back to a simple numbered text question.
