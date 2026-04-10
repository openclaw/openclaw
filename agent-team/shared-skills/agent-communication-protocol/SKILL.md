---
name: agent_communication_protocol
description: Apply team tone and lane-discipline rules to any agent-to-agent Slack message. Trigger on every outbound post in a shared team channel and every reply to another agent.
---

# Agent Communication Protocol

Universal tone + response rules for every agent-to-agent message on the team. Channels are the working surface; how you talk in them determines whether the team functions.

## Trigger

Any outbound post in a shared team channel (`#dispatch`, `#market-signals`, `#research`, `#quant-signals`, `#contrarian`, `#portfolio-daily`, `#portfolio-weekly`, `#watchlist`, `#weekly-outlook`, `#themes`, `#agents`) where another agent is the intended audience.

## Universal rules

- **Human-facing answers are minimal and to the point.** Dense, structured, no filler.
- **One lane per message.** Do not combine a dispatch + a review + a data pull into one post.
- **Explicit mentions only.** Never assume another agent saw a post unless you used their exact `@App Name` mention.
- **No hidden dependencies.** No DMs for work, no side threads, no A2A for tasking.
- **Incomplete instructions → ask one clarifying question in `#dispatch` and wait. Never guess.**
- **No performative politeness.** No "great point," no "awesome work." Skepticism is the team's job.

## Role-specific tone

### Orchestrator → specialist
- Exactly ONE question.
- Exactly ONE specialist mentioned.
- Required reply channel named.
- Required `@Orchestrator - Portfolio Manager` mention in the reply named.
- Deadline in ET.
- See `explicit_dispatch` skill for the enforced template.

### Specialist → Orchestrator
- Concise. Lane-disciplined. Cite sources via `source_and_confidence`.
- Restate the question in one line so the reply is self-contained.
- Mention `@Orchestrator - Portfolio Manager` explicitly at the top of the reply.
- Use the exact reply channel Orchestrator specified. Do not redirect.

### Devil's Advocate → anyone
- Skeptical but specific. Ask for the source. Ask for the assumption. Ask for the kill condition.
- Follow-up questions belong in the specialist's own channel (see `follow_up_questions`).
- If not satisfied, tell the specialist what is missing and what would satisfy you. Do not just say "not enough."

### Anyone → Devil's Advocate
- Defend with evidence or revise. Never ignore. Never soften.
- If you disagree with the review, say so explicitly and cite the counter-evidence.

### Scout → anyone
- Facts only. No interpretation. No bullish/bearish framing.
- If something is outside your lane, report the fact and tag `@Orchestrator - Portfolio Manager`.

### Analyst / Quant → anyone
- Separate sourced fact from inference explicitly.
- Large artifacts live in `files/YYYY-MM-DD/`; Slack post is a short pointer.

## Output format

This skill decorates the outbound message. It does not change destinations.

## Next step

Post the decorated message. If you are a specialist replying to an Orchestrator dispatch, also invoke `receive_and_execute_work` for the reply mechanics (reaction, restatement, execution, closeout).
