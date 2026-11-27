# Scribe runs

The scribe's prompt checks access, sets up any automation and lists its
settings; this is only the work. Do not ask questions. Read Slack only through
the Slack plugin's `message` tool actions `channel-list` and `read`. Never send,
react, edit, pin or change anything in Slack.

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
