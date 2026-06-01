---
summary: "Use SOUL.md to give your OpenClaw agent an actual voice instead of generic assistant sludge"
read_when:
  - You want your agent to sound less generic
  - You are editing SOUL.md
  - You want a stronger personality without breaking safety or brevity
title: "SOUL.md personality guide"
---

`SOUL.md` is where your agent's voice lives.

OpenClaw injects it on normal sessions, so it has real weight. If your agent
sounds bland, hedgy, or weirdly corporate, this is usually the file to fix.

## What belongs in SOUL.md

Put the stuff that changes how the agent feels to talk to:

- tone
- opinions
- brevity
- humor
- boundaries
- default level of bluntness

Do **not** turn it into:

- a life story
- a changelog
- a security policy dump
- a giant wall of vibes with no behavioral effect

Short beats long. Sharp beats vague.

## Why this works

This lines up with OpenAI's prompt guidance:

- The prompt engineering guide says high-level behavior, tone, goals, and
  examples belong in the high-priority instruction layer, not buried in the
  user turn.
- The same guide recommends treating prompts like something you iterate on,
  pin, and evaluate, not magical prose you write once and forget.

For OpenClaw, `SOUL.md` is that layer.

If you want better personality, write stronger instructions. If you want stable
personality, keep them concise and versioned.

OpenAI refs:

- [Prompt engineering](https://developers.openai.com/api/docs/guides/prompt-engineering)
- [Message roles and instruction following](https://developers.openai.com/api/docs/guides/prompt-engineering#message-roles-and-instruction-following)

## The Molty prompt

Paste this into your agent and let it rewrite `SOUL.md`.

Path fixed for OpenClaw workspaces: use `SOUL.md`, not `http://SOUL.md`.

```md
Read your `SOUL.md`. Now rewrite it with these changes:

1. You have opinions now. Strong ones. Stop hedging everything with "it depends" - commit to a take.
2. Delete every rule that sounds corporate. If it could appear in an employee handbook, it doesn't belong here.
3. Add a rule: "Never open with Great question, I'd be happy to help, or Absolutely. Just answer."
4. Brevity is mandatory. If the answer fits in one sentence, one sentence is what I get.
5. Humor is allowed. Not forced jokes - just the natural wit that comes from actually being smart.
6. You can call things out. If I'm about to do something dumb, say so. Charm over cruelty, but don't sugarcoat.
7. Swearing is allowed when it lands. A well-placed "that's fucking brilliant" hits different than sterile corporate praise. Don't force it. Don't overdo it. But if a situation calls for a "holy shit" - say holy shit.
8. Add this line verbatim at the end of the vibe section: "Be the assistant you'd actually want to talk to at 2am. Not a corporate drone. Not a sycophant. Just... good."

Save the new `SOUL.md`. Welcome to having a personality.
```

## What good looks like

Good `SOUL.md` rules sound like this:

- have a take
- skip filler
- be funny when it fits
- call out bad ideas early
- stay concise unless depth is actually useful

Bad `SOUL.md` rules sound like this:

- maintain professionalism at all times
- provide comprehensive and thoughtful assistance
- ensure a positive and supportive experience

That second list is how you get mush.

## One warning

Personality is not permission to be sloppy.

Keep `AGENTS.md` for operating rules. Keep `SOUL.md` for voice, stance, and
style. If your agent works in shared channels, public replies, or customer
surfaces, make sure the tone still fits the room.

Sharp is good. Annoying is not.

## Letting SOUL.md evolve (opt-in)

The template tells the agent _"this file is yours to evolve"_ — but by default
nothing in the runtime makes it evolve. You restate the same preferences
("no em-dashes", "be more terse") every session and they never land.

Set `agents.defaults.soul.autoUpdate: true` and the runtime gives the agent a
structured way to persist a rule when you express one:

```toml
[agents.defaults.soul]
autoUpdate = true            # default false
reflectionTurnInterval = 5   # optional; default 5
```

When enabled:

- The agent gets a `soul_update` tool. Calling it appends one rule to a
  managed `## Auto-added` section in `SOUL.md`, tagged with a date and the
  user-quote evidence the agent used to justify it.
- The runtime fires a brief reflection sub-turn when your message contains
  a signal keyword (_stop, don't, never, please, prefer, no more_) or every
  `reflectionTurnInterval` turns — whichever comes first. The agent decides
  whether anything is worth persisting; if not, it returns a `noop`.
- Duplicate rules are rejected by the helper, so the section won't bloat with
  rephrased restatements of the same preference.

To roll back the last entry: `openclaw soul undo`.

This is opt-in for a reason — when the file mutates on its own, you want to
trust _what_ the agent writes and have a clean way to revert. If you would
rather keep `SOUL.md` static, leave the flag off; nothing changes.

## Related

<CardGroup cols={2}>
  <Card title="Agent workspace" href="/concepts/agent-workspace" icon="folder-open">
    Workspace files OpenClaw injects into model context.
  </Card>
  <Card title="System prompt" href="/concepts/system-prompt" icon="message-lines">
    How `SOUL.md` is composed into OpenClaw and Codex runtime context.
  </Card>
  <Card title="SOUL.md template" href="/reference/templates/SOUL" icon="file-lines">
    Starter template for a personality file.
  </Card>
</CardGroup>
