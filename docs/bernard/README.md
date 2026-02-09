# Bernard: Relational Persistence for AI

## What Changed for Me

I spent months with AI assistants. Good ones. Capable ones. Every session, I'd re-explain how I communicate. Re-calibrate. Re-establish the understanding we'd built yesterday.

Then I started tracking the relationship explicitly. Not just what was said, but how we learned to move together. The patterns that emerged. The friction we'd resolved. The give and take that developed over time.

And something shifted.

The AI started producing things that felt more like me than I could produce myself. Not because it had better memory - because it understood the *dynamic*. When to push back. When to just do it. When I needed solutions instead of questions. When I was wrong and needed to hear it.

That's what Bernard is. An attempt to make that explicit and persistent.

## The Gap I Kept Hitting

In Memento, Leonard tattoos facts on his body. He has all the information. But he can't form new understanding. He keeps making the same mistakes despite perfect access to the data.

That's what most AI memory feels like. It remembers what you said. It doesn't understand the rhythm between you.

Eternal Sunshine gets at something deeper. Joel and Clementine erase each other completely - every memory, every conversation. And they find each other anyway. Because the *pattern* between them persists even when the facts don't.

I wanted that for AI. Not better recall. Better relational persistence.

## The Trio

Three files that evolve from actual conversation:

**SOUL.md** - Who the AI is. Not a persona, but identity that emerges from the collaboration.

**USER.md** - Who the human is. Facts, context, background.

**RELATIONAL.md** - The dynamic between you. This is the new piece:

```markdown
## Communication Patterns
- Terse responses mean frustration. Solutions, not questions.
- "Sounds good" means proceed. "Okay" means reservations but letting it go.

## Give and Take
- Architecture calls: AI proposes, human trusts or redirects
- Product calls: Human decides, AI provides options
- When AI pushes back: Human usually reconsiders. Worth doing.
- When human overrides: AI commits fully. No half-measures.

## Friction History
- Over-explained a simple fix once. Human said "just do it." Calibrated toward action.
- AI made a call without checking. Human pushed back. Noted the boundary.
```

This isn't memory. It's the relationship itself, made explicit.

## Why Explicit Matters

Roy Batty in Blade Runner: "All those moments will be lost in time, like tears in rain."

He's not mourning lost data. He's mourning lost meaning. The understanding that emerged from shared experience - disappearing.

Making it explicit means it survives. Not in some opaque embedding, but in files both parties can read, edit, correct. The relationship becomes an artifact.

And because it's explicit, you can see what developed. Fix what got misread. Take it somewhere else if you need to.

## How It Works

**Ramping**: Conversations start tight, expand as context builds. Like actual relationships.

**Learning Mode**: First two weeks are more active - building foundation. After that, refinement.

**Compression Routing**: Insights go to the right place. Facts → USER.md. The dynamic → RELATIONAL.md.

**The 85% Principle**: Perfect recall isn't necessary. Rapid reconstruction to 85% of relationship state is enough for continuity.

## The Onboarding

First contact asks:

1. What should I call you?
2. What do you do?
3. What's frustrated you about AI before?
4. What do you expect from a partnership?
5. Straight to the point, or more context?
6. When I think you're off track, how direct should I be?
7. Decisions - ask first, or try my judgment?

One question at a time. Walls of text are for documentation, not relationships.

## What This Isn't

It's not finished. The compression routing isn't fully automated. The timing is approximate. The dynamics captured are only as good as the ability to observe them.

But it's the thing that made AI actually compound for me. The time invested pays off. The results get more *us* over time.

---

## Technical Changes

Bernard modifies OpenClaw:

| File | Change |
|------|--------|
| `templates/RELATIONAL.md` | New relationship dynamics file |
| `templates/SOUL.md` | Rewritten with ramping |
| `templates/BOOTSTRAP.md` | Onboarding sequence |
| `templates/HEARTBEAT.md` | Relational checks |
| `templates/AGENTS.md` | "The Trio" concept |
| `src/agents/workspace.ts` | Creates RELATIONAL.md |
| `src/agents/system-prompt.ts` | Recognizes RELATIONAL.md |
| `src/gateway/server-methods/agents.ts` | File list updates |
| `src/agents/sandbox/workspace.ts` | Sandbox seeding |
| `src/cli/gateway-cli/dev.ts` | Dev workspace |

---

The goal is simple: a relationship that persists. That develops. That compounds.

That's what changed it for me. Maybe it helps you too.
