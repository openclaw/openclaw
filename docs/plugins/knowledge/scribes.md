---
summary: "Knowledge scribes: conversations Knowledge starts for you that keep a store up to date, once or on a schedule"
read_when:
  - You want Knowledge to learn from your conversations or from Memory without asking each time
  - You are turning on the scheduled consolidation of unlinked claims
  - You want Granola meetings ingested into Knowledge automatically
  - You want Knowledge to learn from your Slack channels
  - A scribe shows Failing or Conversation not found on the Scribes tab
  - A scribe shows New run instructions after you update OpenClaw
  - A scheduled Learn from Slack run fails because the automation has no recorded creator origin
title: "Knowledge scribes"
sidebarTitle: "Scribes"
---

A scribe is a conversation you own that Knowledge starts for you. It follows a
skill that ships with Knowledge, once or on a schedule, and saves what it finds
to the viewed agent's store. Part of the [Knowledge plugin](/plugins/knowledge)
guide.

Open **Knowledge** in the Control UI and select the **Scribes** tab. Scribes
that are starting, on, disabled, failing, or whose conversation is not found are listed under
**On**. The rest are under **Available**, including a once scribe that is done,
which can be started again.

## The scribes

| Scribe                   | Runs            | Options                                                                          | Skill                           |
| ------------------------ | --------------- | -------------------------------------------------------------------------------- | ------------------------------- |
| Knowledge Consolidation  | Ongoing         | Weekly or nightly                                                                | `knowledge-claim-consolidation` |
| Learn from conversations | Once or ongoing | Active only, or active and archived; starting 30 days, 90 days, all, or today    | `knowledge-ingest`              |
| Learn from Granola       | Once or ongoing | Your meetings, or every meeting you can read; starting 7 days, 30 days, or today | `knowledge-meeting-ingest`      |
| Learn from Memory        | Once            | `MEMORY.md`, daily notes, and the Dreaming diary (`DREAMS.md`)                   | `knowledge-ingest`              |
| Learn from Slack         | Once or ongoing | Starting 7 days, 30 days, or today; Slack user token; direct messages            | `knowledge-source-ingest`       |

- **Knowledge Consolidation** files claims that
  [maintenance](/plugins/knowledge/maintenance) left unlinked, creates pages for
  subjects that deserve one, supersedes status snapshots by their outcome,
  records outcomes in page State, retires written Timelines, and reviews pages
  so each reads as a current explanation. It runs on its own schedule: weekly
  on Sundays at 3:45 AM in your time zone by default, or nightly at 3:45 AM,
  after maintenance links what it can. A weekly run works toward retiring 15
  written Timelines and reviewing 6 pages; a nightly run, 10 and 5. Each run is
  an agent turn over every unlinked claim, so nightly uses more tokens.
  Maintenance itself never starts it.
- **Learn from conversations** saves the decisions, preferences, commitments,
  and lessons from conversations belonging to the agent running the scribe.
  This applies even when session tools normally allow cross-agent reads.
  Ongoing runs check for newly finished
  conversations daily at 4:00 AM in your time zone. Conversations already
  learned from are skipped. Defaults are active conversations from the last 30
  days.
- **Learn from Granola** turns each Granola meeting into a meeting page, updates
  the people, companies, and projects it discusses, and saves its decisions and
  commitments, through the [Granola plugin](#the-granola-plugin). Ongoing runs
  check for finished meetings on weekdays at 10 AM, 2 PM, and 6 PM in your time
  zone. Meetings already in Knowledge are skipped, and a meeting still being
  recorded waits for a later run. It keeps a checkpoint page,
  `Knowledge scribe checkpoint · Learn from Granola`, so an interrupted run
  resumes. Defaults are your meetings (recorded by you or with you invited)
  from the last 7 days.
- **Learn from Memory** brings `memory-core` notes into Knowledge once. Memory
  itself is not changed.
- **Learn from Slack** reads Slack channels through the
  [Slack plugin](#the-slack-plugin) and saves the decisions, commitments, and
  project news discussed there, updating the people, companies, and projects
  involved. Ongoing runs check for new messages on weekdays at 9:30 AM,
  1:30 PM, and 5:30 PM in your time zone. Messages already in Knowledge are
  skipped. It keeps a checkpoint page,
  `Knowledge scribe checkpoint · Learn from Slack`, with the newest message
  ingested in each channel, so a run continues where the last one stopped.
  Defaults are every channel the Slack bot is a member of, from the last 7
  days, without the user token or direct messages.

### The Granola plugin

Learn from Granola reads meetings with the tools of the Granola plugin, which
connects to your Granola account through Granola's MCP server. The Scribes tab
checks the plugin and shows one of:

| Shown                                    | Control              |
| ---------------------------------------- | -------------------- |
| Needs the Granola plugin, not installed  | **Install Granola…** |
| Needs the Granola plugin, turned off     | **Turn on Granola…** |
| Installed, not connected to your account | **Connect Granola…** |
| Granola connected                        | None                 |

Each control opens the plugin's page under **Plugins**, where you install it,
turn it on, or sign in. **Set up…** stays disabled until Granola is connected.
If the page cannot read the plugin's state (for example, without
`operator.read`), it shows nothing and lets you start; a run without the plugin
stops with `Scribe status: failed` and says the plugin is not connected.

The scribe keeps the meeting's Granola ID (the UUID in its
`notes.granola.ai/d/…` link) on the meeting page. It retains the meeting notes
and the full transcript as originals; a meeting without a transcript is not
ingested.

### The Slack plugin

Learn from Slack reads with the bundled Slack channel plugin's `message`
actions: `channel-list` to find channels and `read` for their messages and
threads. It never posts, reacts, or changes anything in Slack, and needs no
separate Slack token. The Scribes tab checks that the plugin is installed and
on, and that its default Slack account is configured and running:

| Shown                                 | Control            |
| ------------------------------------- | ------------------ |
| Needs the Slack plugin, not installed | **Install Slack…** |
| Needs the Slack plugin, turned off    | **Turn on Slack…** |
| Installed, no running Slack account   | **Connect Slack…** |
| Slack connected                       | None               |

**Connect Slack…** opens **Settings → Channels**, where you add or start the
Slack account. **Set up…** stays disabled until the account is running.

The start dialog offers:

- **Starting from**: the last 7 days (default), the last 30 days, or today.
- **Also channels your user token can access** (off by default): also reads
  every channel the Slack account's user token can access, beyond the channels
  the bot is a member of. The option is disabled when the account has no user
  token. Without it, the scribe reads only channels the bot is in. An account
  without a bot token (one that posts as the user) can only be read as the
  user: the dialog says so and **Start** stays disabled until you turn this
  option on. A run of such a scribe without the option stops with
  `Scribe status: failed` and asks for it.
- **Direct messages and group DMs** (off by default): also reads the direct
  messages and group DMs the token can read.

The scribe always names the token it reads with (the actions' `readAs`): the
bot token for channels the bot is in, and the user token only for channels
found through it when that option is on. A direct message is read with the
token whose listing returned it. Archived channels are skipped. Each channel is
one source in Knowledge, keyed `slack:<team>/<channel>`, with retained snapshot manifests, so later runs
reconcile edited messages instead of saving them twice. Every snapshot
is recorded as partial, because Slack reads can't prove that every thread reply
was seen, so a message missing from a later read is never treated as deleted.

Each run re-reads the last 3 days of a channel, so edits within that window
are reconciled; older edits are not. Slack doesn't resurface an old thread when
it gets a new reply, so the checkpoint keeps threads with a reply in the last 90
days and the scribe re-reads them in turn. A reply to a thread quiet for longer
than that is missed. A channel's checkpoint advances only after its ingestion
is verified, and a newly joined channel is read on the next run.

## Start a scribe

Select **Set up…**, **Import…**, or **Turn on…**, choose options, and start.
Running a scribe once needs a connection with write access (`operator.write`).
An ongoing scribe is an automation, so starting or changing one needs a Gateway
administrator (`operator.admin`). Without it, the dialog only offers **Once**,
and the Scribes tab says so.

The dialog's **Prompt** area shows the text the scribe gets: the full message for
a once run, or the run message every scheduled run of an ongoing scribe receives.
It is generated from your choices; expand it to read or edit it before starting.
Once you edit it by hand, changing a choice no longer regenerates it (the dialog
says which it is), and **Use generated prompt** discards your edits. Switching
between once and ongoing also discards them. Start uses the text shown.

1. Knowledge creates a conversation titled `Scribe · <title>` for the viewed
   agent, or reuses the scribe's existing conversation (restoring it if it was
   archived).
2. A once scribe gets the prompt in that conversation, does its work, and
   reports back. Nothing is scheduled. No vault content is included.
3. For an ongoing scribe, the page creates its automation, named
   `Knowledge scribe · <title>`, with your administrator access, and requests
   its first run. The request can wait for scheduler capacity. Because the
   automation is yours rather than an agent turn's, its scheduled runs can read
   channel plugins such as Slack.

On a shared Gateway, visible scribes may belong to another person. Viewing a
scribe does not transfer its ownership or private access. Each run of an
ongoing scribe starts in a fresh session of its conversation (the automation's
`current` session target): it keeps the conversation's private access,
workspace and model settings, but not earlier runs' history, so it reads the
skills that ship with the installed Knowledge rather than copies from earlier
runs. Open a run from **Recent runs** to read what it did. Ongoing scribes also
appear on the Automations page.

### Example run message

Turning on **Knowledge Consolidation** with the weekly default creates an
automation on cron `45 3 * * 0` in your time zone whose run message is:

```text
Scheduled run of the Knowledge scribe "Knowledge Consolidation". Don't ask questions: nobody is watching this turn.

Settings:
- Each run: retire 15 written Timelines and review 6 pages.

Steps:
1. Call knowledge_status. Go on when the scope is private and writes are enabled; a never-written store reports "unprovisioned" and is created by your first Knowledge call. Otherwise stop: ...
2. Follow every step of the "Scribe runs" section of the knowledge-claim-consolidation skill: link and retire unlinked claims, retire written Timelines, and review pages. Do each step even when no claim is left to link. ...
3. End your reply with one line: `Scribe status: on — <one sentence with counts: claims examined, linked, superseded, withdrawn and left; Timelines retired and left; pages reviewed, changed and left unchanged>`.
...
```

To change when it runs, use **Change…** next to **Schedule** in the scribe's
detail. Learn from conversations, Learn from Granola and Learn from Slack also
have **Change…** next to **Settings**, which changes what they read. To change
anything else later runs do, edit the run message on the Automations page.

## After updating OpenClaw

A newer Knowledge can generate a different run message. Earlier versions also
had the scribe's conversation create its automation in an agent turn; such an
automation runs with that turn's account authority, which cannot read channel
plugins such as Slack on a schedule.

### Upgrade an earlier automation

A scribe still on an automation an agent turn created shows **Upgrade
available**, and its detail explains why and offers **Upgrade automation…**.
The page never upgrades one on its own: the replacement can't carry over the
model account recorded on the old automation, so after an upgrade, runs use the
model account of the administrator who upgraded it. Confirming removes the old
automation and creates one you own in the same conversation, keeping its
schedule, run message (an unchanged earlier message becomes the new one), on or
off state and saved options: a model or thinking override, an explicit tool
list, active hours, pacing, idle-only, a trigger, delivery and the failure
alert. The new automation has a new ID, so **Recent runs** starts over; the
earlier runs stay on the Automations page until they age out. If the
replacement is rejected, the page shows the error and the scribe can be set up
again. **Repair** on such a scribe upgrades it the same way and turns it on.

### Updates the page makes on its own

When an administrator opens the Scribes tab, the page brings each ongoing scribe
that already runs on an administrator's automation up to date, in place:

- More than one automation of this agent with the scribe's declaration key is
  reduced to one.
- An automation that runs in its conversation's own session moves to the
  `current` session target, so later runs start fresh.
- A run message that an earlier Knowledge generated, unchanged, is replaced
  with the new one for the same settings.
- The schedule is kept, and a disabled automation stays disabled.
- Only this agent's automations are touched, and an automation changed to
  another payload kind, such as a script, is left as it is.

Each update is tried once per automation revision: if one fails, the tab says
so and doesn't repeat it on every refresh. A scribe that is running or whose
conversation is not found is updated on a later load. Without an administrator,
the page changes nothing.

A saved run message that differs from what this version generates is never
replaced on its own; the page can't tell who changed it. When it still carries
wording the installed Knowledge has replaced, the scribe shows **New run
instructions**, and its detail offers **Replace with new…**. The confirmation
lists the lines that change, for the settings the saved message names, and
confirming saves the new message on the automation. A differing message that
carries no replaced wording shows nothing.

### Review earlier conversation learning

If an earlier run learned from another agent's conversations, later runs ignore
those checkpoint entries. Open the affected agent's vault and use the
`Knowledge scribe checkpoint · Learn from conversations` note and claim citations to
identify records that need review. Withdraw out-of-scope claims or correct
mixed-source claims and their page State after reviewing the evidence. The
upgrade does not automatically remove checkpoint entries, claims, or evidence.
See [Corrections](/plugins/knowledge/corrections) for what withdrawal retains.

## States

| State                  | Meaning                                                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Available              | No scribe conversation, a conversation that never received its prompt, or an ongoing scribe that was turned off.                            |
| Starting               | A once scribe's conversation received its prompt but has not reported its status yet.                                                       |
| On                     | Its automation is enabled and the last run did not fail.                                                                                    |
| Needs attention        | Its last run reported `needs attention`: it finished without doing its work, and nothing outside the run held it back.                      |
| Disabled               | Its automation is disabled.                                                                                                                 |
| Failing                | The last run failed, the scheduler disabled it after repeated failures, a turn reported a failure, or a once turn stopped without a status. |
| Done                   | A once scribe finished.                                                                                                                     |
| Conversation not found | The automation exists but its conversation was archived or deleted. Repair restores an archived one or starts a new one.                    |

The Scribes tab derives an ongoing scribe's state from its automation: whether
it exists and targets the scribe's conversation, whether it is enabled, and its
last run. Each scribe turn also ends its reply with a plain status line, such as
`Scribe status: done — read 3 files, saved 12 items`. The states are `on`,
`done`, `failed`, and `needs attention`. The tab uses that line where the
automation cannot tell: whether a once scribe is Done or Failing, and whether a
run needs attention. It shows the sentence of the last run's line as its
result.

A scheduled Learn from Granola run works toward ingesting 4 meetings; a
one-time run ingests every pending meeting. Each amount is a target: a run
stops short only when nothing is left that something outside the run holds
back.

A scheduled Learn from Slack run works toward ingesting 6 channels with new
messages, oldest checkpoint first, so every channel gets its turn; a one-time
run ingests every channel. Channels without new messages don't count.

A Learn from Granola run reports `needs attention` when it left meetings pending,
ingested none, and nothing outside the run held them back. A meeting stays
pending only while it is still being recorded, its transcript is not ready, or
verification still fails after a fix attempt.

## Controls

Open a scribe for its schedule, settings, next and last run, model, failure
alert, and recent runs. Learn from Granola and Learn from Slack also show their plugin's
state as their source; for Slack, it also says whether the account has a bot token and a user token.

| Control            | Effect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Run now            | Requests a run of the automation. It can wait for scheduler capacity; acceptance is not a running-state report. If a run is already in progress, it does not start another.                                                                                                                                                                                                                                                                                                                                           |
| Disable / Enable   | Disables or enables scheduled runs. While an enabled automation is running, **Stop and disable** also requests cancellation. Enable schedules future runs; it does not resume a cancelled run. **Run now** remains an explicit override.                                                                                                                                                                                                                                                                              |
| Change…            | Next to **Schedule**: picks a schedule the start dialog offers, or a custom one (every day, weekdays or once a week, at one time), and a time zone. Saving changes the automation's schedule. It keeps the run message and other saved options, except that an unedited Knowledge Consolidation message takes the run amounts of the new schedule. A scribe still on an automation a chat turn created shows no **Change…** until it is upgraded.                                                                     |
| Change… (Settings) | Next to **Settings**, for Learn from conversations, Learn from Granola and Learn from Slack: changes which conversations, meetings or Slack channels and direct messages later runs read. Saving generates the run message from the new settings on the same automation. When the run message was edited by hand, its settings can't be read: **Reset…** instead replaces it with the generated one for the default settings, after listing the lines that change.                                                    |
| Remove automation… | Removes the automation and requests cancellation of any active run. The conversation is kept.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Open conversation  | Opens the scribe's conversation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Open run           | In **Recent runs**: opens a run of an ongoing scribe on the Automations page, which keeps its transcript.                                                                                                                                                                                                                                                                                                                                                                                                             |
| Replace with new…  | For a scribe whose saved run message differs and carries replaced wording: lists the lines that change and saves the new message on the automation when you confirm.                                                                                                                                                                                                                                                                                                                                                  |
| Repair             | Gets the automation running again. For an archived conversation it restores the conversation and turns the automation back on. Otherwise it declares the automation again as yours in the scribe's conversation (a new one when the old one was deleted), keeping its schedule, run message (an unchanged earlier message becomes the new one) and options, and turns it on. Repairing an automation a chat turn created replaces it, so **Repair…** first asks for the same confirmation as **Upgrade automation…**. |
| Start again…       | For a failing scribe without an automation: opens the start dialog and sends a new prompt in the same conversation.                                                                                                                                                                                                                                                                                                                                                                                                   |

Controls that change an automation need a Gateway administrator. Writes are
rejected if the automation changed since the page read it; the page shows the
error, and reopening the scribe shows its current state.

## Limits

- The Scribes tab rereads scribe state about every 30 seconds while it is visible,
  so a once result or a finished run can take that long to appear.
- Conversation counts and the `MEMORY.md` size come from Gateway reads. A count
  the Gateway cannot provide is left out rather than estimated.
- The tab reads status lines from the conversation's last 100 messages, and
  for an ongoing scribe from the last 20 messages of its latest run's transcript.
- An ongoing scribe's conversation is the one its automation belongs to (the
  `current` job's session key, or the session an earlier `session:<key>` job
  targets), read by session key, so renaming it is safe. A scribe without an automation is found by
  its `Scribe · <title>` name; renaming that conversation means the scribe starts a
  new one next time.

## Related

- [Ingestion workflows](/plugins/knowledge/ingestion)
- [Maintenance](/plugins/knowledge/maintenance)
- [Control UI](/plugins/knowledge/control-ui)
