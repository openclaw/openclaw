---
summary: "Knowledge scribes: conversations Knowledge starts for you that keep a store up to date, once or on a schedule"
read_when:
  - You want Knowledge to learn from your conversations or from Memory without asking each time
  - You are turning on the scheduled consolidation of unlinked claims
  - You want Granola meetings ingested into Knowledge automatically
  - You want Knowledge to learn from your Slack channels
  - A scribe shows Failing or Conversation not found on the Scribes tab
  - A scribe shows New run instructions after you update OpenClaw
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
  and lessons in your conversations. Ongoing runs check for newly finished
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
   Scribes tab then requests that automation’s first run; the setup turn never
   runs it. If the page is closed when setup finishes, the first run is requested
   the next time the Scribes tab loads. A request can wait for scheduler capacity.
   The page shows **Run requested** until the scheduler reports it running.
   A once scribe does its work and reports back. Nothing is scheduled.

On a shared Gateway, visible scribes may belong to another person. Viewing a
scribe does not transfer its ownership or private access. The conversation’s
model settings apply to setup requests. A once scribe does its work in its
conversation. Each run of an ongoing scribe starts in a fresh session of its conversation (the automation's
`current` session target): it keeps the conversation's private access and
workspace, but not earlier runs' history, so it reads the skills that ship with
the installed Knowledge rather than copies from earlier runs. The conversation
keeps the setup and repair turns; open a run from **Recent runs** to read what
it did. Ongoing scribes also appear on the Automations page.

### Example prompt

Turning on **Knowledge Consolidation** with the weekly default sends:

````text
Set up the Knowledge scribe "Knowledge Consolidation" in this conversation. Don't ask questions: nobody is watching this turn.

This scribe keeps Knowledge consolidated: it files each claim that names no page on the right page (creating pages for subjects that deserve one), retires duplicates and replaced claims, retires written Timelines, and reviews a few pages each run, folding outcomes into page State. The knowledge-claim-consolidation skill does the work on each run.

Settings:
- Runs weekly, Sundays at 3:45 AM America/Los_Angeles (cron `45 3 * * 0`).
- Each run: retire 15 written Timelines and review 6 pages.

Steps:
1. Call knowledge_status. Go on when the scope is private and writes are enabled; a never-written store reports "unprovisioned" and is created by your first Knowledge call. Otherwise stop: ...
2. With the automations tool, list automations for this agent (pass `agentId` from Runtime), including disabled ones, and take those with declaration key `knowledge:scribe:claim-consolidation` whose recorded `owner.agentId` is this agent's ID from Runtime. Leave any with another or missing owner agent unchanged; never remove another agent's automation. ...
3. Add the automation with the automations tool:
   - name: Knowledge scribe · Knowledge Consolidation
   - declaration key: `knowledge:scribe:claim-consolidation`
   - schedule: the cron expression and time zone in the settings
   - session target: `current`, so each run starts in a fresh session of this conversation
   - payload: an agent turn whose message is the run message below, exactly as written inside the fence
   - delivery: none; failure alert after 2 failed runs
   ...
4. Get the automation and check that its session target is `current` and its session key is this conversation's.
5. Don't start a run from this turn: a run started here is skipped when the turn ends. The Scribes page starts the first run.
6. Report the automation's ID and next run time. End your reply with one line: `Scribe status: on — <one sentence: the automation and its next run>`.

If a step fails, stop and end with `Scribe status: failed — <why>` instead. ...

Run message:

```text
Scheduled run of the Knowledge scribe "Knowledge Consolidation". Don't ask questions: nobody is watching this turn.

Settings:
- Each run: retire 15 written Timelines and review 6 pages.

Steps:
1. Call knowledge_status. ...
2. Follow every step of the "Scribe runs" section of the knowledge-claim-consolidation skill: link and retire unlinked claims, retire written Timelines, and review pages. Do each step even when no claim is left to link. ...
3. End your reply with one line: `Scribe status: on — <one sentence with counts: claims examined, linked, superseded, withdrawn and left; Timelines retired and left; pages reviewed, changed and left unchanged>`.
...
```
````

Each scheduled run receives the automation's run message. To change when it
runs, use **Change…** next to **Schedule** in the scribe's detail. To change what later runs
do, ask the scribe's conversation to change its run message. Editing the
message on the Automations page drops the authority of your turn that its runs
use.

## After updating OpenClaw

A newer Knowledge can generate a different run message, and scribes set up
before runs started in fresh sessions ran in their conversation's own session.
When the Scribes tab loads with write access, it asks the conversation of each
ongoing scribe that is behind to update its automation, in one turn that sends
an `Update the Knowledge scribe` prompt. The turn re-declares the automation,
as setup did, so the automation keeps the authority of your own turn. An edit
made directly from the page would drop it. The update:

- Moves an automation that runs in its conversation's own session to the
  `current` session target, so later runs start fresh.
- Replaces a run message that an earlier Knowledge generated, unchanged, with
  the new one for the same settings.
- Keeps the schedule, and keeps a disabled automation disabled.
- Keeps options saved on the automation that the prompt doesn't set, such as a
  model or thinking override, an explicit tool list (kept exact), active hours,
  pacing, idle-only, a trigger, delivery and the failure alert, by passing them
  to the re-declaration.
- Only touches this agent's automations; another agent's scribe with the same
  declaration key is left alone.

A saved run message that differs from what this version generates is never
replaced on its own; the page can't tell who changed it. When it still carries
wording the installed Knowledge has replaced, the scribe shows **New run
instructions**, and its detail offers **Replace with new…**. The confirmation
lists the lines that change, for the settings the saved message names, and
replacing sends the same update turn with the new message. A differing message
that carries no replaced wording shows nothing.

After an update, **Replace with new…** or **Repair** sends its turn, the scribe
shows **Updating…** and the tab refreshes when the automation changes. If it
hasn't changed after 3 minutes, the tab says so and offers **Try again**, which
sends the turn again as a new request; open the conversation to see what the
turn did. The page asks for an update once per automation revision. A
scribe that is running or whose conversation is not found is updated on a later
load. Until the Scribes tab loads, a scribe keeps running its earlier message,
which still works.

## States

| State                  | Meaning                                                                                                                                        |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Available              | No scribe conversation, a conversation that never received its prompt, or an ongoing scribe that was turned off.                               |
| Starting               | The conversation received its prompt but has not reported its status yet.                                                                      |
| On                     | Its automation is enabled and the last run did not fail.                                                                                       |
| Needs attention        | Its last run reported `needs attention`: it finished without doing its work, and nothing outside the run held it back.                         |
| Disabled               | Its automation is disabled.                                                                                                                    |
| Failing                | The last run failed, the scheduler disabled it after repeated failures, a turn reported a failure, or the start turn stopped without a status. |
| Done                   | A once scribe finished.                                                                                                                        |
| Conversation not found | The automation exists but its conversation was archived or deleted. Repair restores an archived one or starts a new one.                       |

The Scribes tab derives an ongoing scribe's state from its automation: whether
it exists and targets the scribe's conversation, whether it is enabled, and its
last run. Each scribe turn also ends its reply with a plain status line, such as
`Scribe status: done — read 3 files, saved 12 items`. The states are `on`,
`done`, `failed`, and `needs attention`. The tab uses that line where the
automation cannot tell: whether a once scribe is Done or Failing, whether setup
succeeded before the page starts the first run, and whether a run needs
attention. It shows the sentence of the last run's line as its result; answers
to setup, repair and update turns are not run results.

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

Open a scribe for its schedule, next and last run, model, failure alert, and
recent runs. Learn from Granola and Learn from Slack also show their plugin's
state as their source; for Slack, it also says whether the account has a bot token and a user token.

| Control            | Effect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Run now            | Requests a run of the automation. It can wait for scheduler capacity; acceptance is not a running-state report. If a run is already in progress, it does not start another.                                                                                                                                                                                                                                                                                                                                                                                  |
| Disable / Enable   | Disables or enables scheduled runs. While an enabled automation is running, **Stop and disable** also requests cancellation. Enable schedules future runs; it does not resume a cancelled run. **Run now** remains an explicit override.                                                                                                                                                                                                                                                                                                                     |
| Change…            | Next to **Schedule**: picks a schedule the start dialog offers, or a custom one (every day, weekdays or once a week, at one time), and a time zone. Saving asks the scribe's conversation to re-declare its automation with the new schedule, in the same kind of turn as an update, so runs keep the authority of your turn. It keeps the run message and other saved options, except that an unedited Knowledge Consolidation message takes the run amounts of the new schedule. The scribe shows **Updating…** until its automation has the new schedule. |
| Remove automation… | Removes the automation and requests cancellation of any active run. The conversation is kept.                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Open conversation  | Opens the scribe's conversation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Open run           | In **Recent runs**: opens a run of an ongoing scribe on the Automations page, which keeps its transcript.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Replace with new…  | For a scribe whose saved run message differs and carries replaced wording: lists the lines that change and asks the conversation to use the new message when you confirm.                                                                                                                                                                                                                                                                                                                                                                                    |
| Repair             | Gets the automation running again. For an archived conversation it restores the conversation and turns the automation back on, without a model turn. For a deleted conversation, or a failing scribe, it asks the scribe's conversation (a new one when deleted) to recreate its automation there, keeping its schedule and run message (an unchanged earlier message becomes the new one), and turn it on.                                                                                                                                                  |
| Start again…       | For a failing scribe without an automation: opens the start dialog and sends a new prompt in the same conversation.                                                                                                                                                                                                                                                                                                                                                                                                                                          |

Controls need write access. Disable, enable, and removal are rejected if the
automation changed since the page read it; the page shows the error, and
reopening the scribe shows its current state.

## Limits

- The Scribes tab rereads scribe state about every 30 seconds while it is visible,
  so a setup result or a finished run can take that long to appear.
- Conversation counts and the `MEMORY.md` size come from Gateway reads. A count
  the Gateway cannot provide is left out rather than estimated.
- The tab reads status lines from the conversation's last 100 messages, and
  for an ongoing scribe from the last 20 messages of its latest run's transcript. A start,
  repair or update answered after that run began decides the state, but the
  shown result stays the run's.
- An ongoing scribe's conversation is the one its automation belongs to (the
  `current` job's session key, or the session an earlier `session:<key>` job
  targets), read by session key, so renaming it is safe. A scribe without an automation is found by
  its `Scribe · <title>` name; renaming that conversation means the scribe starts a
  new one next time.

## Related

- [Ingestion workflows](/plugins/knowledge/ingestion)
- [Maintenance](/plugins/knowledge/maintenance)
- [Control UI](/plugins/knowledge/control-ui)
