---
summary: "Single ownership of transcript entries: every visible message is in its chat's model history once"
read_when:
  - Changing where automation results, message-tool sends, or alerts are written into session transcripts
  - Adding a new path that posts messages into a chat
  - Reviewing cron session targets or delivery routing
title: "Conversation transcript ownership"
---

# Conversation transcript ownership

**Partly implemented.** A chat's model-visible transcript is the log of what that
chat showed. One owner writes that log for every outbound message. Scheduled jobs
either run inside a chat or run in the background; they never do both. Steps 1
and 2 are implemented; the job-mode migration remains.

## Problem

Users reply to messages they can see. Before #168996, many messages that a chat
showed were not in that chat's model history, and some entries in model history
were never shown:

- Cron results that went to another chat reached the recipient only as a
  transcript-only mirror or a `System:` awareness note. Cron results that went to
  the creating chat used a separate canonical writer.
- Messages that a job sends with the `message` tool are stored in the receiving
  chat as transcript-only mirrors. Provider replay skips them
  ([#168683](https://github.com/openclaw/openclaw/issues/168683)).
- Failure alerts are sent but not written to any transcript
  ([#168684](https://github.com/openclaw/openclaw/issues/168684)).
- A job with `sessionTarget: "session:<key>"` that delivers to a different chat
  adds its whole run to the `<key>` conversation, which showed nothing.

Each path had its own rules, so each edge case needed its own fix.

## Decision

### Rule 1: the transcript matches the chat

A message is in conversation C's model-visible history if and only if C showed
it. It is written once, as the same message that was shown, after the channel
confirms delivery.

Allowed exceptions, each recorded as a `warn` run diagnostic:

- The destination chat is bound to a different agent. The message is sent; no
  agent's transcript gets it.
- The payload is native-only (for example a Discord embed with no text). The
  message is sent; there is no honest text to write.

### Rule 2: a job runs in a chat, or in the background

| Mode           | User intent                     | Run lives in                         | Result shown in      |
| -------------- | ------------------------------- | ------------------------------------ | -------------------- |
| **In chat**    | "Check in with me here daily"   | A normal turn in that chat           | The same chat only   |
| **Background** | "Send me a budget report daily" | Its own job session (memory allowed) | One destination chat |

An in-chat job cannot deliver to another chat. A background job never writes its
run into a chat's transcript; only its result reaches the destination through
Rule 1. Today's targets map as follows: `main` is in chat; `isolated` and
`current` are background (`current` adds a snapshot of the creating chat);
`session:<key>` is in chat when it delivers to `<key>`, and must become a
background job with its own session when it delivers elsewhere.

### One owner

The outbound send owner writes the transcript entry for every confirmed visible
send: automation results, failure alerts, `message`-tool sends, and subagent
announcements. It skips the write only when the send is the reply of a turn that
runs in the same conversation, because that turn already wrote it. That skip is
the reason delivery mirrors became transcript-only in
[#99470](https://github.com/openclaw/openclaw/issues/99470): without it, replay
showed every answer twice. Cron keeps no external-delivery transcript code of its own.
Internal-channel publications remain outside this change.

Same-conversation source-reply markers remain transcript-only: the UI and restart
recovery consume their source-turn and terminal-receipt identities. They do not
add model-visible conversation content. Dispatch's final-reply bookkeeping also
remains transcript-only for UI display when the runtime did not persist a final.

## Considered options

- **Opt-in continuation, as in Hermes Agent.** Hermes runs every job in a fresh
  session and delivers fire-and-forget by default. `cron.mirror_delivery` or a
  per-job `attach_to_session` adds a labelled user message to the destination
  session. Rejected as the default: a reply to a delivered message should work
  without configuration, and a switch per job is a setting users must discover.
- **Always write to the creating chat too.** Rejected: the creating chat would
  hold messages it never showed, so the agent can refer to things the user did
  not see. Run history already answers "what did that job send?".
- **Keep recipient mirrors and awareness notes.** Rejected: several writers, best
  effort, no wait for an active turn, no idempotency, and the model sees a note
  about the message instead of its own message.

## Status and order

1. **Done ([#168996](https://github.com/openclaw/openclaw/pull/168996)).** Cron
   results go to the destination chat once, through the canonical writer
   (`src/sessions/background-session-result.ts`), after confirmed delivery.
   Mirrors and awareness notes are removed.
2. **Done.** The outbound send owner writes confirmed visible messages through
   `src/sessions/background-session-result.ts`. Cron, the `message` tool, failure
   alerts, external heartbeats, and subagent announcements use the same writer.
   A producing conversation keeps its own turn instead of a second delivery row;
   cross-conversation sends enter the destination's model history once. External
   awareness notes and the cron-specific delivery writer are removed.
   Closes #168683 and #168684.
3. **Two job modes.** Doctor migrates existing jobs. A `session:<key>` job that
   delivers elsewhere becomes a background job with its own session. That job
   loses the `<key>` conversation as context, so Doctor reports each migrated job.
4. **Show the posting job to the model**
   ([#168685](https://github.com/openclaw/openclaw/issues/168685)), so "stop this"
   on a delivered message needs no lookup.

## Limits and risks

- **Repeated assistant turns.** Canonical results survive replay even when their
  text matches the previous assistant message. Transcript-only delivery mirrors
  remain excluded. See [#169369](https://github.com/openclaw/openclaw/pull/169369).
- **Recovery.** A recovered send enters history only for a single accepted,
  normalized-text payload. Multi-payload batches and media, presentation, or
  native batches are skipped with a warning because the queue cannot confirm
  their final delivered content.
- **Native projections.** Polls are native-only and are not added to the
  conversation; see [#169297](https://github.com/openclaw/openclaw/issues/169297).
- **Session key parity.** The write must land in the exact session that an
  inbound reply uses. X has a known mismatch
  ([#168686](https://github.com/openclaw/openclaw/issues/168686)).
- **Reset of the creating chat.** Implicitly routed results still fail closed
  after a reset ([#169258](https://github.com/openclaw/openclaw/issues/169258)).
  Under Rule 1 a reset chat is the same chat; this needs a product decision.
- **Prompt cache.** Entries are appended at the end and never rewrite earlier
  history, so the cached prefix stays valid.
