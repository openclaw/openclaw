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

| Scribe                   | Runs            | Options                                                                       | Skill                       |
| ------------------------ | --------------- | ----------------------------------------------------------------------------- | --------------------------- |
| Review unlinked claims   | Ongoing         | None                                                                          | `knowledge-unlinked-claims` |
| Learn from conversations | Once or ongoing | Active only, or active and archived; starting 30 days, 90 days, all, or today | `knowledge-ingest`          |
| Learn from Memory        | Once            | `MEMORY.md`, daily notes, and the Dreaming diary (`DREAMS.md`)                | `knowledge-ingest`          |

- **Review unlinked claims** files claims that
  [maintenance](/plugins/knowledge/maintenance) left unlinked, creates pages for
  subjects that deserve one, and records outcomes in page State.
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

1. Knowledge creates a conversation titled `Scribe · <title>` for the viewed
   agent, or reuses the scribe's existing conversation (restoring it if it was
   archived).
2. It sends that conversation a fixed setup message: the skill to follow and the
   options you chose as JSON. No vault content is included.
3. An ongoing scribe creates one automation for itself and reports `on`. The
   Scribes tab then runs that automation once as its first run; the setup turn
   never runs it. If the page is closed when setup finishes, the first run starts
   the next time the Scribes tab loads.
   A once scribe does its work and reports back. Nothing is scheduled.

Scribes run as you, with your private access to the store, and use the agent's
default model. Read everything a scribe did by opening its conversation. Ongoing
scribes also appear on the Automations page.

## States

| State                 | Meaning                                                                                                                                       |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Available             | No scribe conversation, a conversation that never received its setup, or an ongoing scribe that was turned off.                               |
| Starting              | The conversation received its setup but has not reported its result yet.                                                                      |
| On                    | Its automation is enabled and the last run did not fail.                                                                                      |
| Paused                | Its automation is disabled.                                                                                                                   |
| Failing               | The last run failed, the scheduler disabled it after repeated failures, setup reported a failure, or the setup turn stopped without a result. |
| Done                  | A once scribe finished.                                                                                                                       |
| Needs reauthorization | The automation exists but its conversation was archived or deleted.                                                                           |

Each scribe turn ends its reply with one `SCRIBE_RESULT` line. The Scribes tab
reads the latest one for the result summary.

## Controls

Open a scribe for its schedule, next and last run, model, options, failure
alert, and recent runs.

| Control           | Effect                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------- |
| Run now           | Runs the automation immediately. If a run is already in progress, it does not start another.            |
| Pause / Resume    | Disables or enables the automation.                                                                     |
| Turn off…         | Removes the automation. The conversation is kept.                                                       |
| Open conversation | Opens the scribe's conversation.                                                                        |
| Repair            | Restores an archived conversation, or creates one, and asks it to re-check and recreate its automation. |
| Retry             | For a failed once scribe: sends its setup message again, as a new attempt, in the same conversation.    |

Controls need write access. Pause, resume, and turn off are rejected if the
automation changed since the page read it; the page shows the error, and
reopening the scribe shows its current state.

## Limits

- The Scribes tab rereads scribe state about every 30 seconds while it is visible,
  so a setup result or a finished run can take that long to appear.
- Conversation counts and the `MEMORY.md` size come from Gateway reads. A count
  the Gateway cannot provide is left out rather than estimated.
- Repair and Retry reuse the options of the latest setup message the page can still read
  in the conversation (its last 100 messages); otherwise it uses the defaults.
- The page finds a scribe's conversation by its `Scribe · <title>` name and, for an
  ongoing scribe, picks the one its automation targets. Renaming the conversation
  hides it from the tab: a once scribe starts a new conversation next time, and an
  ongoing one shows Needs reauthorization.

## Related

- [Ingestion workflows](/plugins/knowledge/ingestion)
- [Maintenance](/plugins/knowledge/maintenance)
- [Control UI](/plugins/knowledge/control-ui)
