---
summary: "How OpenClaw reviews finished work in the background and saves lessons as learned skills"
read_when:
  - You want OpenClaw to learn reusable procedures from its conversations
  - You are deciding whether to leave self-learning on or turn it off
  - You need to know what a background review sees, costs, or changes
  - Nothing is being learned and you want to know why
title: "Self-learning"
sidebarTitle: "Self-learning"
---

Self-learning turns corrections and hard-won procedures into
[learned skills](/tools/skill-workshop) that future sessions load. It is on by
default (`skills.workshop.autonomous.mode: "auto"`).

Learning happens in three places:

- **The foreground agent** patches a learned skill that misled it and saves a
  procedure after hard multi-step work, in the same turn.
- **A background review** looks back over a conversation after enough work and
  saves what the foreground agent did not. This page covers it.
- **Unused-skill cleanup** archives learned skills unused for 30 days. See
  [Unused-skill cleanup](/tools/skill-workshop#unused-skill-cleanup).

Every change applies immediately, is announced in the conversation, and can be
undone. See [Undo](/tools/skill-workshop#undo).

## When a review runs

OpenClaw counts model iterations per session, across turns. When a session
reaches 10 since its last review, a review is queued and the count starts over.
The count also resets when the foreground turn itself changed a learned skill,
so work the agent already saved is not reviewed again.

A turn that read or viewed a learned skill also queues a review, whatever the
count, so a skill that just misled or helped the agent gets a fresh look. The
same eligibility rules apply, and a turn that changed a learned skill itself
still skips the review.

A queued review starts after 30 seconds with no agent or reply run active; later
activity in the same session restarts that wait. Reviews run one at a time.
The foreground reply never waits for a review.

These turns do not count:

- turns that ended in a provider or prompt error. Turns you interrupted still
  count.
- cron, heartbeat, hook, subagent, memory, and Incognito sessions, and
  background Workshop runs themselves.
- turns on a runtime that does not report its resolved model and whether
  `skill_workshop` was available. The embedded runner and the Codex app-server
  harness report both.
- turns where tool policy hides `skill_workshop`.

Compacted sessions are eligible. Counts are kept in memory, so a Gateway restart
starts them over.

## What a review does

The review forks the conversation through the finished turn and appends one
instruction, reusing the foreground provider, model, auth profile, and tool
schemas so the provider's prompt cache applies. Model fallbacks are disabled. It
runs on the embedded OpenClaw harness under a private session that never
appears in your transcript.

The review can look things up with `read`, `ls`, `view_image`, `web_search`,
`web_fetch`, `sessions_history`, `sessions_search`, `memory_search`, and
`memory_get`; `skill_workshop` is the only tool that changes anything. Tools that
act, such as `exec`, `write`, or `message`, return a normal result such as
`exec is not available in this background run.` That result is not a failure,
and the review never re-runs your task. The review must `view` a skill
before it patches, writes, or archives it, and an archive needs `absorbed_into`
or `reason`.

The reviewer looks for:

- a correction to your approach, output, or style.
- a non-obvious technique, fix, or command sequence that worked after trial and
  error.
- a learned skill that was wrong, missing a step, or outdated.

It lists learned skills first, then prefers patching a skill that was used or
already covers the task, then adding a `references/`, `templates/`, or
`scripts/` file to one, and creates a new skill only when none covers the task.
Listed skills that cover the same class of task get merged into one umbrella
skill: the review patches the survivor and archives the rest with
`absorbed_into`. When the turn was interrupted, it keeps only steps that visibly
worked before the stop.

It does not capture environment-specific or transient failures, negative claims
about tools, unresolved failures or guesses, knowledge about one codebase,
one-off tasks, personal facts, secrets, or generic advice without concrete
commands, paths, or ids. When nothing durable was learned, it changes nothing.

## What you see

If the review changed a skill, one line is posted to the conversation that
triggered it and mirrored into the session transcript:

```text
💾 Learned: updated `deploy-staging` (tightened the rollback step). Say "undo" to revert this skill change.
```

Channel-less Control UI sessions get the line as a transcript entry. Nothing is
posted when nothing changed. Reply "undo" and the agent restores the previous
version.

A review stops without changing anything further if you turn learning off, or
if the source session is deleted, replaced, or changes permission mode while it
runs. Changes it already made stay, each with a saved previous version.

## Turn it on or off

```bash
openclaw config set skills.workshop.autonomous.mode off
openclaw config set skills.workshop.autonomous.mode auto
```

The Control UI **Plugins → Skill workshop** page has the same switch. `off`
stops background reviews and unused-skill cleanup. The agent can still create or
update learned skills when you ask, through `/learn`, or in a
**Learn from past conversations** session.

## Cost and privacy

A review is one extra model run on the foreground provider and model after
substantial work, not after every message. It can make several requests while
it views and edits skills. Prompt-cache reuse lowers the cost of re-reading the
conversation; provider pricing still applies.

**Learn from past conversations** opens a normal chat in which the agent reads
earlier conversations it can access, with its configured model and tools. You
can watch, steer, or stop it. Starting one does not change the learning mode.

<Warning>
  Background reviews and learning sessions send conversation content, including
  tool inputs and results, to the configured model provider. Choose a provider
  and mode that match the workspace's privacy and data-handling requirements.
</Warning>

## Troubleshooting

### Nothing is learned

1. `skills.workshop.autonomous.mode` is `auto` in the active Gateway config.
2. The session did at least 10 model iterations since its last review, without
   provider or prompt errors.
3. The session is an ordinary conversation, not cron, heartbeat, hook,
   subagent, or Incognito.
4. Tool policy allows `skill_workshop` and the session is not sandboxed. In
   `auto` mode, `openclaw doctor` reports the setting that hides it.
5. The Gateway stayed up and idle for the 30-second wait.

A review that ran can still decide nothing is worth saving. That is the
expected result for routine work.

### Too many or unwanted changes

Undo individual changes with "undo", the Control UI **Undo** button, or
`openclaw skills workshop restore <name>`. Archive a skill you do not want with
`openclaw skills workshop archive <name>`. To stop background learning, set the
mode to `off`.

## Related

- [Skill Workshop](/tools/skill-workshop) for the tool, storage, undo, and unused-skill cleanup
- [Creating skills](/tools/creating-skills) for hand-written skills
- [Skills config](/tools/skills-config#workshop-skills-workshop) for `skills.workshop`
- [Skills CLI](/cli/skills#skill-workshop) for `openclaw skills workshop`
