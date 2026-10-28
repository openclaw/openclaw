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

Every change applies immediately and can be undone. Background review changes
appear in the Control UI chat. See [Undo](/tools/skill-workshop#undo). To
review background learning before it applies, use `propose` mode: reviews save
[drafts](/tools/skill-workshop#drafts) that you review with `/learn drafts`.

## When a review runs

OpenClaw counts model iterations per session, across turns. When a session
reaches 10 since its last review, a review is queued and the count starts over.
The count also resets when the foreground turn itself changed a learned skill,
so work the agent already saved is not reviewed again.

Reading or viewing a learned skill does not queue an extra review; those turns
count toward the same 10-iteration threshold.

A queued review normally starts after 30 seconds with no agent or reply run active;
later activity in the same session restarts that wait on a best-effort basis.
Reviews run one at a time.
The foreground reply never waits for a review. A review yields when another
agent or reply run starts; it is not replayed. A later eligible turn can queue
fresh evidence. Resetting the
conversation or changing its permissions cancels the review. Before changing a
skill, the review also verifies that its original transcript anchor is still valid.

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

The review reads a recent excerpt through the finished turn, bounded to 64
transcript events and 32 KiB. Large tool results can be replaced with explicit
omission notices; missing outcomes must not be inferred. If a required context
boundary cannot fit, the review stops without a model call.

It reuses the foreground provider, model, and auth profile, with a minimal
prompt and only the `skill_workshop` tool. Workspace bootstrap files, the full
skill catalog, client tools, and foreground-only instructions are omitted.
The run targets a 16,384-token context budget. Review responses use at most
2,048 output tokens and low reasoning effort; the run lasts at most two minutes.
Context maintenance uses the runtime's normal compaction policy, so these
settings are not a hard total-token limit for a successful multi-step review. Model fallbacks and transient provider retries
are disabled. It runs on the embedded OpenClaw harness under a private session that never
appears in your transcript. It is internal system work, not a new user turn;
user-only reply hooks, including Advisor admission, do not run for it.

The review uses `skill_workshop` to list and view learned skills and save a
lesson supported by the excerpt. It cannot browse files, fetch more history,
or re-run your task. The review must `view` a skill
before it patches, writes, or archives it, and an archive needs `absorbed_into`
or `reason`.

The reviewer keeps your learned skills a small set of repeatable procedures, so
most reviews change nothing. It changes a skill only for a class of task you
will ask for again, where the next run would go wrong or redo work without the
change. The evidence is one of:

- a correction to the agent's method.
- a non-obvious method that worked after trial and error.
- a learned skill with a wrong, missing, or outdated step.

Details true of only one request, such as one product, order, menu, date,
place, or booking, stay in the conversation.

A review makes at most one change. It lists learned skills first, then either
sharpens the step the lesson changes in the skill for that class of task, or
creates one focused skill when none covers it. An unrelated class of task gets
its own skill instead of a new branch in an existing one. When two listed skills
cover the same class of task, the review merges them: it patches the survivor
and archives the other with `absorbed_into`. When the turn was interrupted, it
keeps only steps that visibly worked before the stop.

It does not capture environment-specific or transient failures, negative claims
about tools, unresolved failures or guesses, knowledge about one codebase,
one-off tasks, personal facts, secrets, or generic advice without concrete
commands, paths, or ids.

## What you see

When a review changes a skill, the Control UI chat shows a **Learned** row: one
chip per changed skill, each opening that skill in the Skill Workshop, and an
**Undo** button. Nothing appears when nothing changed.

Channel messages are off by default. Set
`skills.workshop.autonomous.channelNotices: true` to post the notice to the
conversation that triggered the review instead. That session's Control UI
chat then shows the channel message as plain text, not the **Learned** row:

```text
💾 Learned: updated `deploy-staging` (tightened the rollback step). Say "undo" to revert this skill change.
```

Slack never gets a channel message; its sessions still get the Control UI row.

To undo everything the review changed, press **Undo** on the Control UI row or
channel notice. Channels that do not render buttons show a copyable
`/learn undo <id>` command; the id comes from the channel notice. You can also
say "undo" in the conversation, whether channel notices are on or off, and the
agent restores the previous version. See
[Skill Workshop undo](/tools/skill-workshop#undo).

A review stops without changing anything further if you turn learning off, or
if the source session is deleted, replaced, or changes permission mode while it
runs. Changes it already made stay, each with a saved previous version.
Expected cancellations during Gateway shutdown or a source transcript change
appear only in debug logs. Provider and storage failures still produce warnings.

## Turn it on or off

```bash
openclaw config set skills.workshop.autonomous.mode off
openclaw config set skills.workshop.autonomous.mode propose
openclaw config set skills.workshop.autonomous.mode auto
```

The Control UI **Plugins → Skill workshop** page has the same switch. `propose`
keeps background reviews but saves their changes as drafts and skips
unused-skill cleanup. `off` stops background reviews and unused-skill cleanup. The agent can still create or
update learned skills when you ask, through `/learn`, or in a
**Learn from past conversations** session.

## Cost and privacy

A review is one extra model run on the foreground provider and model after
substantial work, not after every message. It can make several bounded requests
while it views and edits skills. It uses its own prompt rather than replaying
the whole foreground prefix; provider pricing still applies.

A rate-limit error from a review or foreground turn pauses all background
reviews in this Gateway for 15 minutes. Repeated saturation increases that wait
to 30 minutes, then at most one hour; fresh foreground rate limits extend the
current wait, and a successful review resets the backoff.
Pending reviews coalesce by session while waiting. Failed or interrupted reviews
are discarded instead of retried. These limits protect this Gateway's
interactive work; they do not reserve organization quota against other clients.

**Learn from history** in the Control UI opens a normal chat in which the agent reads
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
   `auto` mode, `openclaw doctor` reports the setting that hides it unless a
   matching deny intentionally opts the agent out. Denying `skill_workshop`
   or `group:agents` opts that agent out without a Doctor warning.
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
