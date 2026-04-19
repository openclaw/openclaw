---
title: Minions
description: Durable job queue that powers subagents, ACP, CLI, and cron
---

# Minions

Minions are durable subagents. They survive gateway restarts, cancel as a group,
and track their own token spend.

When you spawn a subagent, schedule a cron tick, or start an ACP session,
openclaw creates a **minion** — a row in a local SQLite database that persists
the job's state through crashes, restarts, and network failures. If the gateway
dies mid-flight, minions pick up where they left off.

## What minions give you

- **Crash recovery.** Gateway restarts? Your subagents resume from the last
  progress checkpoint, not from scratch.
- **Cascade cancel.** Cancel a parent and every descendant stops burning tokens.
- **Parallel fan-out.** `sessions_spawn_many` runs N subagents in parallel with
  bounded concurrency and automatic token roll-up.
- **Token accounting.** Every minion tracks input/output/cache tokens. Child
  tokens roll up to the parent automatically.
- **Idempotency.** Duplicate submissions with the same key return the existing
  job instead of creating a second one.
- **Inbox steering.** Send messages to a running minion mid-flight to change its
  behavior without restarting it.

## The `openclaw minions` CLI

```bash
openclaw minions list              # show recent jobs
openclaw minions list --status active  # show running jobs
openclaw minions stats             # queue health dashboard
openclaw minions get 42            # full details for job #42
openclaw minions cancel 42         # cancel job + all descendants
openclaw minions smoke             # quick smoke test
```

## Architecture

Every unit of deferred work — subagent, ACP peer, CLI run, cron tick — is a
minion with the same lifecycle:

```
waiting → active → completed
                 → failed → (retry with backoff) → waiting
                 → dead (max attempts or unrecoverable)
                 → cancelled (cascade from parent)
```

Minions run on `node:sqlite` with WAL mode. No new runtime dependencies.
The worker uses lock-heartbeat renewal (not polling) for sub-second stall
detection.

## For plugin authors

Extensions can schedule durable work via the Plugin SDK:

```typescript
import { MinionQueue, MinionStore } from "openclaw/plugin-sdk/minions-runtime";
```

See [Plugin SDK: Minions](/plugins/sdk-minions) for the full contract.
