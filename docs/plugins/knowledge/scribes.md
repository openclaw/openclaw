---
summary: "Knowledge scribes: conversations Knowledge starts for you that keep a store up to date, once or on a schedule"
read_when:
  - You want Knowledge to learn from your conversations or from Memory without asking each time
  - You are turning on the scheduled review of unlinked claims
  - A scribe shows Failing or Needs reauthorization on the Scribes tab
title: "Knowledge scribes"
sidebarTitle: "Scribes"
---

A scribe is a conversation you own that Knowledge starts for you. It follows a
skill that ships with Knowledge, once or on a schedule, and saves what it finds
to the viewed agent's store. Part of the [Knowledge plugin](/plugins/knowledge)
guide.

Open **Knowledge** in the Control UI and select the **Scribes** tab. Scribes
that are starting, on, paused, failing, or need reauthorization are listed under
**On**. The rest are under **Available**, including a once scribe that is done,
which can be started again.

## The scribes

| Scribe                   | Runs            | Options                                                                       | Skill                   |
| ------------------------ | --------------- | ----------------------------------------------------------------------------- | ----------------------- |
| Review unlinked claims   | Ongoing         | Weekly or nightly                                                             | `knowledge-maintenance` |
| Learn from conversations | Once or ongoing | Active only, or active and archived; starting 30 days, 90 days, all, or today | `knowledge-ingest`      |
| Learn from Memory        | Once            | `MEMORY.md`, daily notes, and the Dreaming diary (`DREAMS.md`)                | `knowledge-ingest`      |

- **Review unlinked claims** files claims that
  [maintenance](/plugins/knowledge/maintenance) left unlinked, creates pages for
  subjects that deserve one, supersedes status snapshots by their outcome, and
  records outcomes in page State. It runs on its
  own schedule: weekly on Sundays at 3:45 AM in your time zone by default, or
  nightly at 3:45 AM, after maintenance links what it can. Each run is an agent
  turn over every unlinked claim, so nightly uses more tokens. Maintenance
  itself never starts it.
- **Learn from conversations** saves the decisions, preferences, commitments,
  and lessons in your conversations. Ongoing runs check for newly finished
  conversations daily at 4:00 AM in your time zone. Conversations already
  learned from are skipped. Defaults are active conversations from the last 30
  days.
- **Learn from Memory** brings `memory-core` notes into Knowledge once. Memory
  itself is not changed.

## Start a scribe

Select **Set up…**, **Import…**, or **Turn on…**, choose options, and start.
Starting needs a connection with write access (`operator.write`).

The dialog's **Prompt** area shows the full message the page sends. It is
generated from your choices; expand it to read or edit it before starting. Once
you edit it by hand, changing a choice no longer regenerates it (the dialog says
which it is), and **Use generated prompt** discards your edits. Start sends the
text shown.

1. Knowledge creates a conversation titled `Scribe · <title>` for the viewed
   agent, or reuses the scribe's existing conversation (restoring it if it was
   archived).
2. It sends that conversation the prompt: what the scribe does, its settings as
   plain bullets, and numbered steps. No vault content is included.
3. An ongoing scribe creates one automation for itself and reports `on`. The
   Scribes tab then runs that automation once as its first run; the setup turn
   never runs it. If the page is closed when setup finishes, the first run starts
   the next time the Scribes tab loads.
   A once scribe does its work and reports back. Nothing is scheduled.

Scribes run as you, with your private access to the store, and use the agent's
default model. Read everything a scribe did by opening its conversation. Ongoing
scribes also appear on the Automations page.

### Example prompt

Turning on **Review unlinked claims** with the weekly default sends:

````text
Set up the Knowledge scribe "Review unlinked claims" in this conversation. Don't ask questions: nobody is watching this turn.

This scribe reviews Knowledge claims that name no page: it files each one on the right page, creates pages for subjects that deserve one, supersedes status snapshots by their outcome, and folds the outcomes into page State. The knowledge-maintenance skill does the work on each run.

Settings:
- Runs weekly, Sundays at 3:45 AM America/Los_Angeles (cron `45 3 * * 0`).

Steps:
1. Call knowledge_status. Go on when the scope is private and writes are enabled, or the store is unprovisioned (...). Otherwise stop: ...
2. With the automations tool, list automations including disabled ones and take those with declaration key `knowledge:scribe:unlinked-review`. Remove each one owned by another conversation, ...
3. Add the automation with the automations tool:
   - name: Knowledge scribe · Review unlinked claims
   - declaration key: `knowledge:scribe:unlinked-review`
   - schedule: the cron expression and time zone in the settings
   - session target: `session:` followed by this conversation's session key (from Runtime)
   - payload: an agent turn whose message is the run message below, exactly as written inside the fence
   - delivery: none; failure alert after 2 failed runs
   ...
4. Get the automation and check that it targets this conversation.
5. Don't start a run from this turn: a run started here is skipped when the turn ends. The Scribes page starts the first run.
6. Report the automation's ID and next run time. End your reply with one line: `Scribe status: on — <one sentence: the automation and its next run>`.

If a step fails, stop and end with `Scribe status: failed — <why>` instead. ...

Run message:

```text
Scheduled run of the Knowledge scribe "Review unlinked claims". Don't ask questions: nobody is watching this turn.

Steps:
1. Call knowledge_status. ...
2. Follow the "Scribe runs" section of the knowledge-maintenance skill: review every claim that names no page until none is left to decide. ...
3. End your reply with one line: `Scribe status: on — <one sentence with counts: claims examined, linked, superseded, withdrawn and left>`.
...
```
````

Each scheduled run receives the automation's run message. To change what later
runs do, edit the scribe's automation on the Automations page: its message is
the run message, and its schedule is the scribe's schedule.

## States

| State                 | Meaning                                                                                                                                        |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Available             | No scribe conversation, a conversation that never received its prompt, or an ongoing scribe that was turned off.                               |
| Starting              | The conversation received its prompt but has not reported its status yet.                                                                      |
| On                    | Its automation is enabled and the last run did not fail.                                                                                       |
| Paused                | Its automation is disabled.                                                                                                                    |
| Failing               | The last run failed, the scheduler disabled it after repeated failures, a turn reported a failure, or the start turn stopped without a status. |
| Done                  | A once scribe finished.                                                                                                                        |
| Needs reauthorization | The automation exists but its conversation was archived or deleted.                                                                            |

The Scribes tab derives an ongoing scribe's state from its automation: whether
it exists and targets the scribe's conversation, whether it is enabled, and its
last run. Each scribe turn also ends its reply with a plain status line, such as
`Scribe status: done — read 3 files, saved 12 items`. The states are `on`,
`done`, and `failed`. The tab uses that line where the automation cannot tell:
whether a once scribe is Done or Failing, and whether setup succeeded before the
page starts the first run. It also shows the line's sentence as the result
summary.

## Controls

Open a scribe for its schedule, next and last run, model, failure alert, and
recent runs.

| Control           | Effect                                                                                                                                        |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Run now           | Runs the automation immediately. If a run is already in progress, it does not start another.                                                  |
| Pause / Resume    | Disables or enables the automation.                                                                                                           |
| Turn off…         | Removes the automation. The conversation is kept.                                                                                             |
| Open conversation | Opens the scribe's conversation.                                                                                                              |
| Repair            | Restores an archived conversation, or creates one, and asks it to re-check and recreate its automation, keeping its schedule and run message. |
| Start again…      | For a failing scribe without an automation: opens the start dialog and sends a new prompt in the same conversation.                           |

Controls need write access. Pause, resume, and turn off are rejected if the
automation changed since the page read it; the page shows the error, and
reopening the scribe shows its current state.

## Limits

- The Scribes tab rereads scribe state about every 30 seconds while it is visible,
  so a setup result or a finished run can take that long to appear.
- Conversation counts and the `MEMORY.md` size come from Gateway reads. A count
  the Gateway cannot provide is left out rather than estimated.
- The tab reads status lines from the conversation's last 100 messages.
- The page finds a scribe's conversation by its `Scribe · <title>` name and, for an
  ongoing scribe, picks the one its automation targets. Renaming the conversation
  hides it from the tab: a once scribe starts a new conversation next time, and an
  ongoing one shows Needs reauthorization.

## Related

- [Ingestion workflows](/plugins/knowledge/ingestion)
- [Maintenance](/plugins/knowledge/maintenance)
- [Control UI](/plugins/knowledge/control-ui)
