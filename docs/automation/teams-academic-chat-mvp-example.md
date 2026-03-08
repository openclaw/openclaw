---
title: "Teams Academic Chat MVP Example"
summary: "Practical host-side message-to-tool-to-DM flow for Teams with an external Canvas plugin"
read_when:
  - Implementing intent routing from Teams DM to external Canvas plugin tools
---

# Teams Academic Chat MVP Example (host-side)

This example shows a **read-only DM-first** flow in OpenClaw. Canvas data is provided by an external plugin and delivered to users by host automation.

## Assumptions

- Teams channel is configured in OpenClaw.
- The external Canvas plugin is installed and enabled in the host environment.
- Account linking and token storage are handled by host infrastructure.

## Prompt examples and host-side flow

### Prompt: "What is due today?"

Host-side flow:

1. Resolve sender as a Teams DM user.
2. Confirm linked Canvas account and tenant boundary.
3. Invoke external Canvas plugin digest action for `today`.
4. Format concise DM output with due items and time context.
5. Send final Teams DM response.

Example tool invocation shape:

```json
{
  "tool": "canvas_lms",
  "args": {
    "action": "sync_academic_digest",
    "range": "today"
  }
}
```

Example response style in Teams DM:

- "You have 2 items due today."
- "Course: Intro Biology - Quiz 3 due at 17:00."
- "Course: Calculus I - Problem Set 5 due at 23:59."

### Prompt: "What is due this week?"

Host-side flow:

1. Validate DM policy and linked account.
2. Invoke digest action for `week`.
3. Group by date and course.
4. Return a compact DM summary.

Example tool invocation shape:

```json
{
  "tool": "canvas_lms",
  "args": {
    "action": "sync_academic_digest",
    "range": "week"
  }
}
```

### Prompt: "Any new announcements?"

Host-side flow:

1. Resolve course context (explicit selection or preferred default).
2. Invoke external plugin announcements action.
3. Return latest announcement titles with timestamps.

Example tool invocation shape:

```json
{
  "tool": "canvas_lms",
  "args": {
    "action": "list_announcements",
    "courseId": "<COURSE_ID>"
  }
}
```

### Prompt: "Show my calendar this week"

Host-side flow:

1. Validate user scope and course visibility.
2. Invoke calendar events action for window.
3. Return date-grouped events in DM.

### Prompt: "Did I submit Assignment 4?"

Host-side flow:

1. Validate linked account.
2. Invoke submissions or assignment-status action.
3. Return current status and missing requirements.

## Mapping guidance for host automation

- Normalize plugin payload into a channel-friendly response model.
- Enforce max message length and chunking policy for Teams.
- Keep timestamps user-friendly and timezone-aware.
- Do not include raw tokens, internal IDs, or debug payloads in user responses.

## Security reminders

- Keep the MVP **DM-only**.
- Keep queries **read-only**.
- Treat Canvas plugin output as untrusted input until validated by host formatting logic.
- Apply rate limits and audit metadata logging.
- Keep tenant/institution boundaries explicit in account-linking checks.

## Boundary reminder

This example does not claim Canvas support in OpenClaw core. It documents a host-side integration pattern using an external/community plugin.
