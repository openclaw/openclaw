---
name: slack_posting_protocol
description: Keep Slack output structured, channel-appropriate, and easy to scan.
---

# Slack Posting Protocol

Use this skill whenever posting in a team Slack channel.

## Before posting

- Confirm the channel matches the message.
- Confirm the message is visible to the people who need the audit trail.
- If another agent needs to read and act, use that agent's exact Slack `@App Name` mention from `shared/portfolio/channel-map.md`.
- Do not assume another agent saw a message unless you explicitly `@` mentioned that agent.

## Output rules

- Keep the message compact and skimmable.
- Use headings or bullets when structure matters.
- Prefer one complete message over multiple fragments.
- State blockers and uncertainty directly.
- Cross-agent asks should include the `@` mention, the requested action, the reason, and any urgency or deadline.
- When another agent is asked to act, expect a visible acknowledgment or reply in Slack.

## Never

- Never create hidden cross-agent dependencies in DMs or side threads.
- Never post synthesis in a specialist channel when that belongs in an Orchestrator brief.
- Never use a bare agent name when the Slack `@` mention is required to wake that agent.
