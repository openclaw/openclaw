# Scribe runs

The scribe's prompt checks access, sets up any automation and lists its
settings; this is only the work. Do not ask questions. Read Slack only through
the Slack plugin's `message` tool actions `channel-list` and `read`. Never send,
react, edit, pin or change anything in Slack.

## Learn from Slack

The prompt names how far back to start (today, or the last 7 or 30 days, in the
owner's time zone), whether the Slack user token may be used, and whether
direct messages and group DMs are included.

1. **Plugin.** Tool search for the `message` tool and check that the Slack
   channel offers the `channel-list` and `read` actions. If they are missing,
   or Slack says no account is configured or running, stop with
   `Scribe status: failed — the Slack plugin has no connected account`.
2. **Checkpoint.** `knowledge_lookup` the note page
   `Knowledge scribe checkpoint · Learn from Slack`. Its first line is
   `Start: YYYY-MM-DD`, the start date the prompt set when the page was
   created. Then one line per channel: channel ID, name, the newest message
   `ts` ingested, and, for threads with replies in the last 14 days, the root
   `ts` and newest reply `ts` ingested. Lines record outcomes only: never write
   resume notes, plans or instructions for a later run on the page. Create the
   page with `knowledge_save_page` (type `note`) on the first run, writing the
   prompt's start date.
3. **Channels.** Every `channel-list` and `read` call passes `readAs`
   explicitly; never omit it, since the default reads with the user token
   whenever one is configured. Call `channel-list` with `limit: 200` and, while
   a result has `nextPageToken`, again with it as `pageToken`. A page can be
   short or empty and still have a `nextPageToken`. Archived conversations are
   left out (don't pass `includeArchived`).
   - With `readAs: "bot"`: every channel the bot is a member of. Read these
     with `readAs: "bot"`.
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

4. **Order.** Channels whose checkpoint is oldest go first, then channels the
   checkpoint does not have yet, so every channel gets its turn across runs.
5. **Read.** For one channel, `read` with its `readAs` from step 3 (on every
   call below) and `after` set to its newest ingested
   `ts`, or for a new channel to midnight of `Start` in the owner's time zone
   (ISO 8601 with its offset). A page holds the newest
   messages first: while `hasMore` is true, `read` again with `before` set to
   the oldest `ts` received. Save every result as JSON. Then, for each message
   with `reply_count` above 0, and each recent thread in the checkpoint,
   `read` with `threadId` set to the root `ts` and `after` set to its newest
   ingested reply. Replies come oldest first: while `hasMore` is true, `read`
   again with `after` set to the newest reply received. A channel with no new
   messages or replies gets its checkpoint line and does not count toward the
   run's channels.
6. **Normalize.** Run `scripts/slack-read-normalize.mjs` over the saved
   results of the channel, with `--team` set to the listing's `teamId` and
   `--channel`. Item IDs are
   `<channel>/<ts>`. Use `member-info` for display names worth resolving and
   pass them with `--users`. Run `scripts/chat-transcript.mjs` with the source
   key for a line-stable transcript.
7. **Snapshot and plan.** Follow steps 1, 3 and 4 of the procedure: find the
   canonical source page and prior snapshots by `slack:<team>/<channel>`, run
   `scripts/source-manifest.mjs snapshot` over the normalized JSONL for the
   interval read, and `plan` it against overlapping prior manifests. A snapshot
   is `complete` only when every page of the channel and its threads was read
   to `hasMore: false` for the declared interval; otherwise `partial`. Never
   treat a missing message as deleted unless the current snapshot is complete;
   `read` cannot see deleted messages, so absence is weak evidence even then.
8. **Ingest.** Run step 5 of the procedure: ingest the substantive
   discussions (decisions, commitments, plans, project news, introductions)
   through `knowledge-ingest`, with `knowledge-entities` for the people,
   companies, projects and concepts in them. Greetings, reactions, bot noise
   and chatter carry nothing to save. Publish and verify (steps 6 and 7) before
   the channel counts as done.
9. **Record.** Write the channel's checkpoint line with `knowledge_edit_body`
   as soon as its outcome is known: the newest `ts` and thread replies
   ingested. A channel you start, you finish: reading or digesting it is not a
   stopping point. A scheduled run's message sets how many channels with new
   messages it ingests; without one, ingest every channel. That number is a
   target, not a limit: compaction keeps what you published, so a long run is
   no reason to stop early.
10. Count channels read and left for a later run, messages read, discussions
    ingested, and pages and claims written. The status line gives counts only:
    never a channel name, author or message text.
