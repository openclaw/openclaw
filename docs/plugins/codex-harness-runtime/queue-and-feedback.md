---
summary: "Active-run queue steering on Codex turns and the Codex feedback upload path"
read_when:
  - You are steering messages into an active Codex run
  - You are running /diagnostics on a native Codex session
title: "Codex queue steering and feedback upload"
sidebarTitle: "Queue steering and feedback"
---

Sending messages into a running Codex turn, and uploading Codex thread logs with diagnostics. Part of the [Codex harness runtime](/plugins/codex-harness-runtime) guide; [Where each section moved](/plugins/codex-harness-runtime#where-each-section-moved) lists every section.

## Queue steering

Active-run queue steering maps onto Codex app-server `turn/steer`. With the
default `messages.queue.mode: "steer"`, OpenClaw batches steer-mode chat
messages for the configured quiet window and sends them as one `turn/steer`
request in arrival order.

Inline images and stored attachments keep their original image order. Stored
images use the same hydration, size limits, and filesystem restrictions as a
new turn. If an attachment cannot be prepared or steering is rejected, the
complete message remains queued for a follow-up turn. Preparation and the
`turn/steer` acknowledgment do not count as consumption; a message sent to
Codex without confirmed consumption is not replayed automatically.

When Codex confirms consumption, OpenClaw saves completed visible assistant
items before the steered user message, including items before a tool or sleep
handoff. Each item keeps its own identity so later steers do not duplicate it.
This history prefix is separate from the turn's final-answer selection.

Codex review and manual compaction turns can reject same-turn steering. In
that case, OpenClaw waits for the active run to finish before starting the
prompt. Use `/queue followup` or `/queue collect` when messages should queue
by default instead of steering. See [Steering queue](/concepts/queue-steering).

## Codex feedback upload

When `/diagnostics [note]` is approved for a session on the native Codex
harness, OpenClaw also calls Codex app-server `feedback/upload` for relevant
Codex threads, including logs for each listed thread and spawned Codex
subthreads when available.

The upload goes through Codex's normal feedback path to OpenAI servers. If
Codex feedback is disabled in that app-server, the command returns the
app-server error. The completed diagnostics reply lists the channels,
OpenClaw session ids, Codex thread ids, and local `codex resume <thread-id>`
commands for the threads that were sent.

If you deny or ignore the approval, OpenClaw does not print those Codex ids
and does not send Codex feedback. The upload does not replace the local
Gateway diagnostics export. See [Diagnostics export](/gateway/diagnostics) for
the approval, privacy, local bundle, and group-chat behavior.

Use `/codex diagnostics [note]` only when you want the Codex feedback upload
for the currently attached thread without the full Gateway diagnostics
bundle.
