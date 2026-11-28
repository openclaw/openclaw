# Scribe runs

The scribe's prompt checks access, sets up any automation and lists its
settings; this is only the work. Do not ask questions. Read Slack only through
the Slack plugin's `message` tool actions `channel-list` and `read`. Never send,
react, edit, pin or change anything in Slack. Read Gmail only through
`scripts/gmail-read.mjs`. Never run `composio` yourself, and never send, draft,
label, archive or delete mail.

## Learn from Slack

The token, opt-in and coverage rules below follow the owner's decision that the
scribe reads with the bot token by default, and with the user token or in
direct messages only when the owner opts in
([#202411](https://github.com/openclaw/openclaw/pull/202411)). Omitting
`readAs` reads with the user token whenever one is configured, so every call
names its token ([#202410](https://github.com/openclaw/openclaw/pull/202410)).
The re-read window, thread revisits, always-partial snapshots and names taken
only from `read` results address review of the first version of this scribe
([#202411](https://github.com/openclaw/openclaw/pull/202411)).

The prompt names how far back to start (today, or the last 7 or 30 days, in the
owner's time zone), whether the Slack user token may be used, and whether
direct messages and group DMs are included.

1. **Plugin.** Tool search for the `message` tool and check that the Slack
   channel offers the `read` and `channel-list` actions. If `read` is missing,
   or Slack says no account is configured or running, stop with
   `Scribe status: failed — the Slack plugin has no connected account`. If
   only `channel-list` is missing, stop with
   `Scribe status: failed — Slack channel listing is off (the channels.slack.actions.channelInfo setting)`.
2. **Checkpoint.** `knowledge_lookup` the note page
   `Knowledge scribe checkpoint · Learn from Slack`. Its first line is
   `Start: YYYY-MM-DD`, the start date the prompt set when the page was
   created. Then one line per channel: channel ID, name, the date the channel
   was last finished, and the newest message `ts` ingested; under it, one line
   per thread whose newest reply is less than 90 days old: root `ts`, newest
   reply `ts` ingested and the date the thread was last read. Drop a thread
   line once its newest reply is 90 days old. Lines record outcomes only: never
   write resume notes, plans or instructions for a later run on the page.
   Create the page with `knowledge_save_page` (type `note`) on the first run,
   writing the prompt's start date.
3. **Channels.** Every `channel-list` and `read` call passes `readAs`
   explicitly; never omit it, since the default reads with the user token
   whenever one is configured. Call `channel-list` with `limit: 200` and, while
   a result has `nextPageToken`, again with it as `pageToken`. A page can be
   short or empty and still have a `nextPageToken`. Archived conversations are
   left out (don't pass `includeArchived`).
   - With `readAs: "bot"`: every channel the bot is a member of. Read these
     with `readAs: "bot"`. If that call says the account has no bot token
     (an account that posts as the user): with the user-token setting on, go
     on with the `readAs: "user"` listing and reads below only; with it off,
     stop with
     `Scribe status: failed — the Slack account has no bot token; turn on the user-token setting to read as the user`.
   - Only when the settings allow the user token: also list with
     `readAs: "user"`. If that call says no user token is configured, go on
     with the bot's channels only. Read channels found only in this listing
     with `readAs: "user"`. Without the setting, never list or read with
     `readAs: "user"`, and never read a channel the bot is not a member of.
   - Only when the settings include direct messages: pass
     `types: ["public_channel", "private_channel", "im", "mpim"]` to the
     listings above. Read each DM with the `readAs` of the listing that
     returned it. Otherwise keep the default types (channels only).

   Each listing's top-level `teamId` is the workspace of its channel IDs; the
   source key is `slack:<teamId>/<channel id>`.

4. **Order.** A channel without a checkpoint line counts as the oldest, so a
   newly joined channel goes first; then channels by the date they were last
   finished, oldest first. Every channel gets its turn across runs.
5. **Read.** Pass the channel's `readAs` from step 3 on every call.
   - **History.** `read` with `after` set to 3 days before the channel's newest
     ingested `ts` (never before `Start`), or for a new channel to midnight of
     `Start` in the owner's time zone (ISO 8601 with its offset). The 3-day
     overlap re-reads recent messages so edits are reconciled; an edit to a
     message older than that is not. A page holds the newest messages first:
     while `hasMore` is true, `read` again with `before` set to the oldest `ts`
     received.
   - **Threads.** Slack history does not show an old root again when it gets a
     new reply, so threads are read by root. Read every thread whose root is in
     the history read and has `reply_count` above 0; every checkpointed thread
     whose newest reply is less than 14 days old; and up to 10 more
     checkpointed threads, those read longest ago. `read` with `threadId` set
     to the root `ts` and `after` set to 3 days before its newest ingested
     reply (or the root `ts` for a new thread). Replies come oldest first: while
     `hasMore` is true, `read` again with `after` set to the newest reply
     received. A reply to a thread that has no checkpoint line (quiet for 90
     days, or older than `Start`) is not seen.

   Save every result as JSON. A channel whose reads hold nothing newer than its
   checkpoint gets its finished date and does not count toward the run's
   channels.

6. **Normalize.** Run `scripts/slack-read-normalize.mjs` over the saved
   results of the channel, with `--team` set to the listing's `teamId` and
   `--channel`. Item IDs are `<channel>/<ts>`. Authors and mentioned users are
   named only from what `read` returned (author profile, bot name or
   `userProfiles`), otherwise by their stable Slack user ID; never look names
   up with another action. Write a mentioned user by the name the transcript
   shows, not as `<@U…>`. Run
   `scripts/chat-transcript.mjs` with the source key for a line-stable
   transcript.
7. **Snapshot and plan.** Follow steps 1, 3 and 4 of the procedure: find the
   canonical source page and prior snapshots by `slack:<team>/<channel>`, run
   `scripts/source-manifest.mjs snapshot` over the normalized JSONL for the
   interval read (`--completeness partial`), and `plan` it against
   overlapping prior manifests. Learn from Slack snapshots are always
   `partial`: thread reads start at different points than the history read,
   and replies under roots without a checkpoint line are never read, so Slack
   reads can't prove a message is gone. A missing message is never treated as
   deleted.
8. **Ingest.** Run step 5 of the procedure: ingest the substantive
   discussions (decisions, commitments, plans, project news, introductions)
   through `knowledge-ingest`, with `knowledge-entities` for the people,
   companies, projects and concepts in them. Greetings, reactions, bot noise
   and chatter carry nothing to save. Publish and verify (steps 6 and 7) before
   the channel counts as done.
9. **Record.** Only after the channel's ingestion is published and verified,
   write its checkpoint line with `knowledge_edit_body`: today's date, the
   newest `ts` and the thread lines read. A channel that failed keeps its old
   line, so the next run reads it again. A channel you start, you finish:
   reading or digesting it is not a stopping point. A scheduled run's message
   sets how many channels with new messages it ingests; without one, ingest
   every channel. That number is a target, not a limit: compaction keeps what
   you published, so a long run is no reason to stop early.
10. Count channels read and left for a later run, messages read, discussions
    ingested, and pages and claims written. The status line gives counts only:
    never a channel name, author or message text.

## Learn from Mail

The owner decided that this scribe reads Gmail through Composio, and that a
decision model decides which threads are ingested. Its extraction follows
gbrain's open loops: what the owner promised, and who is waiting on whom.

The prompt names how far back to start (today, or the last 7 or 30 days, in the
owner's time zone) and whether threads with mail the owner sent are listed too.

1. **Connection.** Run `node scripts/gmail-read.mjs check`. It prints
   `{"ok": true, "account": "<address>"}`, or `{"ok": false, "problem", "detail"}`.
   Stop on a failure, with the status line its problem names:
   - `cli-missing`: `Scribe status: failed — the Composio CLI is not installed on the Gateway host`
   - `signed-out`: `Scribe status: failed — the Composio CLI is not signed in (composio login)`
   - `gmail-not-linked`: `Scribe status: failed — Gmail is not linked in Composio (composio link gmail)`
   - `temporary` or `gmail-error`: `Scribe status: failed — Gmail could not be read through Composio`

   Run every `gmail-read.mjs` command the same way, and stop the same way when
   one fails. When several Gmail accounts are linked, Composio asks for one:
   that is a `gmail-error` to report, not one to choose for the owner.
2. **Checkpoint.** `knowledge_lookup` the note page
   `Knowledge scribe checkpoint · Learn from Mail`. Its first lines are
   `Start: YYYY-MM-DD` (the start date the prompt set when the page was
   created), `Account: <address>` and `Listed through: <RFC 3339 time>`. Then
   one line per thread:
   `<thread id> · history <history id> · messages <messages digest> · newest <YYYY-MM-DD> · <outcome>`,
   where the outcome is `ingested` or `skipped (<reason>)`. Drop a thread line
   once its newest message is 90 days old. Lines record outcomes only: never
   write resume notes, plans or instructions for a later run on the page.
   Create the page with `knowledge_save_page` (type `note`) on the first run,
   writing the prompt's start date, the checked account and no
   `Listed through` line. If `Account` names another address than the check
   printed, stop with
   `Scribe status: failed — the Gmail account linked in Composio changed`.
3. **List.** Note the time, then run
   `node scripts/gmail-read.mjs list --after <epoch seconds> [--sent] --output list.json`,
   with `--sent` when the settings list sent mail. Start one day before
   `Listed through`, or at midnight of `Start` in the owner's time zone when
   there is none; never before `Start`. The script leaves out promotions,
   social and forums mail, chats and drafts, and returns threads oldest change
   first. A thread whose checkpoint line has the same history ID is unchanged:
   leave it.
4. **Fetch.** Work through the other threads in that order, in batches of up
   to 20: fetch, prefilter and triage a batch (steps 4 to 6), ingest the
   threads it picked (step 7), then take the next batch. Fetch with
   `node scripts/gmail-read.mjs threads --id <thread id> ... --output-dir threads`. Then run
   `node scripts/gmail-normalize.mjs triage --account <address> --input threads/<id>.json ...`.
   A thread whose `messages_digest` is the one on its checkpoint line holds the
   same messages and only changed labels (it was read, starred or archived):
   update its history ID and keep its outcome. Any other digest means a message
   was added or deleted: triage it again, and ingest an `ingested` thread again
   whatever the triage says, so the manifest plan reconciles the change.
5. **Prefilter.** A triage row with a `prefilter` reason (`list-mail`,
   `automated-sender`, `bulk-category`, `calendar-notice`, `spam-or-trash` or
   `no-mail`) is skipped with that reason, without reading it further. The
   prefilter keeps every thread the owner wrote in, whatever its labels.
6. **Triage.** For each remaining row, call `decision_evaluate` with the row's
   `decision` object unchanged. Its `ingest` answer decides: an explicit
   `answer` of `true`, or a `probabilityTrue` of at least 0.5 without one,
   means ingest; otherwise skip with the `kind` choice as the reason (for
   example `skipped (routine)`). When the agent has no `decision_evaluate`
   tool, or the result is unavailable, an error or an abstention (`null`),
   decide yourself from the same state and criteria, and write the reason as
   `skipped (rubric: <kind>)`. Never send the thread anywhere else to decide.
   Write each skipped thread's line as soon as it is decided.
7. **Ingest.** Oldest first, one thread at a time:
   1. Run `node scripts/gmail-normalize.mjs messages --account <address> --input threads/<id>.json --output messages.jsonl`.
      Its stderr names the source key `gmail:<address>/<thread id>` and the
      thread's Gmail link. Run `scripts/chat-transcript.mjs` over it with
      `--channel "Email: <subject>"` and the source key for a line-stable
      transcript.
   2. Follow steps 1, 3 and 4 of the procedure: find the canonical source page
      and prior snapshots by the source key, run
      `scripts/source-manifest.mjs snapshot` (`--provider gmail`,
      `--completeness complete`, coverage from the first message to the time
      the thread was fetched), and `plan` it against prior manifests. A thread
      read is the whole thread, drafts left out, so a message missing from a
      later read was deleted in Gmail; that is observed source state, not a
      reason to erase Knowledge. Keep the Gmail link on the canonical source
      page.
   3. Run step 5 of the procedure through `knowledge-ingest`, with
      `knowledge-entities` for the people, companies and projects. Resolve
      each sender and recipient who matters by the `email:<address>` alias
      first ([identity](identity.md)); add the alias to a person page you
      create or confirm. The account address is the owner. Never write an email
      address in page prose.
   4. Save the thread's decisions and commitments in both directions: what the
      owner promised or asked for, and who is waiting on the owner (or on
      whom the owner waits), each with the counterparty, the date and any due
      date, as `commitment` or `decision` claims on the most specific page.
      A question addressed to the owner that their newest message did not
      answer is someone waiting on the owner. Quoted text, signatures and
      newsletters carry nothing to save.
   5. Publish and verify (steps 6 and 7) before the thread counts as done, then
      write its line `ingested`.

   A thread you start, you finish: reading or digesting it is not a stopping
   point. A thread whose ingestion fails keeps its old line (or none), so the
   next run reads it again. A scheduled run's message sets how many threads it
   ingests and the most it triages; without one, triage and ingest every
   listed thread. The ingest number is a target, not a limit: compaction keeps
   what you published, so a long run is no reason to stop early.
8. **Record.** When every listed thread has a line, set `Listed through` to
   the time noted in step 3 with `knowledge_edit_body`. A run that left
   threads for later keeps the old value, so the next run lists them again.
9. Count threads listed, left out by the prefilter, triaged, skipped, ingested
   and left for a later run, and pages and claims written. The status line
   gives counts only: never a subject, sender, address or message text.
