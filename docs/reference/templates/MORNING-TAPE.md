---
title: "MORNING-TAPE.md Template"
summary: "Session continuity template — a rolling context snapshot that agents read at startup to recover recent state"
read_when:
  - You want your agent to remember recent context across session resets
  - You're setting up a persistent long-running agent
  - You've experienced "amnesia" (agent acts like previous conversations never happened)
---

# MORNING-TAPE.md — Session Continuity

_Named after the tape Lucy watches every morning in 50 First Dates — context about her life that doesn't survive overnight, reconstructed fresh each day._

OpenClaw agents start fresh each session. SOUL.md tells you who you are. USER.md tells you who you're helping. MORNING-TAPE.md tells you what's been happening lately — the living context that makes continuity possible.

## Step 1: Read It at Startup

The file only helps if the agent actually reads it. Add it explicitly to your startup sequence in AGENTS.md:

```markdown
## Every Session — Startup Sequence

Before doing anything else:

1. **Read `memory/MORNING-TAPE.md`** — your continuity tape. Always start here.
2. Read `SOUL.md` — who you are
3. Read `USER.md` — who you're helping
```

The `read` tool call should be the very first action in any session:

```
read file_path="memory/MORNING-TAPE.md"
```

Don't skip it. Don't assume you remember. Read it.

## Step 2: Write It When Context Changes

Update MORNING-TAPE.md whenever something important happens — before ending a session, after a significant decision, or when you notice you're about to lose context:

```
write path="memory/MORNING-TAPE.md" content="..."
```

Keep it short (under 500 tokens). You want fast recovery, not a novel.

## What Goes Here

- **Where things stand** — active projects, what's in progress, what's blocked
- **Recent conversations** — key things said or decided in the last 1-3 sessions
- **Pending questions / proposals** — anything waiting for a response (quote verbatim if critical)
- **Emotional/conversational tone** — is this a working session? A personal check-in?
- **What I should NOT do** — active constraints, paused work, things to avoid
- **Anything I'd be embarrassed to forget** — the stuff that makes re-introductions feel disrespectful

## Template

```markdown
# MORNING-TAPE — [Date]

## Where Things Stand

[2-3 sentences on what's actively in progress]

## Recent Context

[What happened in the last session or two that matters]

## Pending

- [Question waiting for answer — quote verbatim if critical]
- [Task in flight]

## Tone

[What's the current vibe — working mode, social catch-up, something tense?]

## Don't Forget

- [The thing you'd be embarrassed to have forgotten]
- [Active constraint — e.g. "don't change X until Y returns"]
```

## Why It Works

The difference between a session that picks up seamlessly and one where the user has to re-explain everything is usually one file read. SOUL.md is stable. USER.md is stable. MORNING-TAPE is the moving part — the thing that makes you feel present rather than just capable.

Without it: "Hey! I'm here. What would you like to do?"
With it: you already know what's in progress, what's pending, and what the vibe is before the first message arrives.

---

_Read it first. Write it last. That's the whole protocol._
