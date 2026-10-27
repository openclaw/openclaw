---
doc-schema-version: 1
summary: "Graceful Gateway restarts send one ordinary resume input to each running root session; crashes are deliberately lossy"
read_when:
  - You want to know what happens to agent work when the Gateway restarts
  - A restart interrupted an agent, sub-agent, or background process
  - You are checking shutdown or post-update behavior
title: "Restart recovery"
---

A graceful Gateway stop or restart records which root sessions are working, then
aborts that work promptly. At the next startup, each marked session gets one
ordinary system input asking the agent to inspect current state and continue.
The transcript remains the agent's context; the Gateway does not reconstruct or
replay the old execution.

A crash or `SIGKILL` does not write these markers. Nothing resumes automatically
from that process. Open the conversation and send a message to continue. This is
an accepted loss window: files, external actions, and tool effects may already
have changed, so check them before repeating work.

## What survives a restart

| State                                                | Behavior                                                                        |
| ---------------------------------------------------- | ------------------------------------------------------------------------------- |
| Conversations and transcripts                        | Remain in the per-agent SQLite database                                         |
| Running root session at graceful shutdown            | Receives one resume input at the next startup                                   |
| Accepted user input captured in that shutdown marker | Runs after the resume input, in FIFO order, with its sender's current authority |
| Running sub-agent                                    | Stops quietly; its root requester receives the resume input                     |
| Background process                                   | Ends with the old process; its root session receives the resume input           |
| Already-produced outbound messages and media         | Keep the existing delivery queue and delivery reconciliation                    |
| Scheduled jobs                                       | Keep cron's own scheduling, catch-up, and interruption policy                   |
| ACP or external-harness session                      | Keeps its harness owner's restart policy                                        |
| Update outcome                                       | Remains a passive report in the originating conversation                        |
| Gateway terminal PTY                                 | Ends with the old process                                                       |

A session counts as running when its own agent loop is active, a descendant
sub-agent is running, or it owns a running background process. The Gateway reads
these facts from their live in-memory owners during shutdown. A child contributes
to its top-level requester; the child does not receive an independent resume input.
Idle and finished sessions are not marked. Cron occurrence sessions and
ACP/external-harness sessions are excluded.

The marker is a small private field on the existing session entry. It records the
IDs of accepted user inputs still queued behind that session at shutdown. The
Gateway writes one marker per running root session, batched by session store,
before aborting work. It uses the existing session-entry JSON in SQLite and needs
no schema migration.
There are no restart checkpoints written per turn or tool call, startup orphan
scans, or crash-time execution reconstruction.

<a id="graceful-restarts-drain-first" />

## Graceful shutdown

Once a stop or restart is committed, the Gateway fences new admission, snapshots
running sessions, writes their markers, and aborts active runs. It waits only a
short bounded time for in-flight persistence and gives other resource cleanup a
bounded grace. A long model stream, tool call, or background process does not get
a full run-completion drain before shutdown.

A plain stop (`SIGTERM` or `SIGINT`) arriving during an in-process restart makes
the Gateway finish its bounded shutdown and exit instead of starting again.
Managed update handoffs keep their own stop handling.

An external stop or restart logs bounded-grace leftovers, such as a service-child
cleanup deadline, lifetime sidecar, or retained plugin runtime, and exits with
status `0`. A runtime that still owns resources is never reused for an in-process
restart: the process exits so its supervisor can start a fresh Gateway. A real
persistence failure still reports failure.

Reversible suspension and host freeze preparation keep their own semantics. A
suspension does not mark sessions or abort them. Preparation with `drain: true`
can become ready once persistence is clear; the committed stop or restart performs
the snapshot and abort.

Requests the Gateway did not accept before admission closed receive the ordinary
retryable restart error. Clients retain their submission IDs and use normal
reconnect handling. A disconnected RPC may already have performed its work;
clients reconcile the existing receipt rather than replaying arbitrary RPCs.
