---
summary: "Wake your agent programmatically from scripts, cron, webhooks, and CI pipelines"
read_when:
  - You want to trigger the agent from a bash script or external automation
  - You need to programmatically wake the agent without a cron job
  - You want to send context to the agent from a monitoring script
title: "System Events"
---

# System Events: Wake Your Agent from Scripts

System events let you programmatically inject messages into your agent's main
session from external scripts, cron jobs, CI pipelines, or any process that can
run a CLI command. This is the recommended way to trigger agent actions from
outside OpenClaw.

## The Command

```bash
openclaw system event --mode now --text "Your message here"
```

This enqueues a system event and immediately triggers a heartbeat so the agent
processes it right away.

### Flags

| Flag              | Description                                                    |
| ----------------- | -------------------------------------------------------------- |
| `--text <text>`   | **Required.** The message to inject into the agent session.    |
| `--mode <mode>`   | `now` (trigger immediately) or `next-heartbeat` (wait for next scheduled tick). Default: `next-heartbeat`. |
| `--json`          | Machine-readable JSON output.                                  |

### Delivery modes

- **`now`**: Triggers a heartbeat immediately. The agent wakes up, sees the
  system event as a `System:` line in its prompt, and acts on it. Use this for
  urgent or time-sensitive triggers.

- **`next-heartbeat`**: Queues the event for the next scheduled heartbeat cycle.
  The agent picks it up whenever the next heartbeat fires. Use this for
  non-urgent notifications that can wait a few minutes.

## Recipes

### Wake the agent from a bash script

```bash
#!/bin/bash
# check-inbox.sh — lightweight pre-check before waking the LLM

URGENT_COUNT=$(curl -s https://api.example.com/inbox/urgent | jq '.count')

if [ "$URGENT_COUNT" -gt 0 ]; then
  openclaw system event \
    --mode now \
    --text "Urgent inbox: $URGENT_COUNT unread messages need attention"
fi
```

This pattern (sometimes called a "gatekeeper") lets you run cheap API checks in
bash and only wake the agent (and spend tokens) when there's real work to do.

### Webhook receiver that triggers the agent

```bash
#!/bin/bash
# webhook-handler.sh — called by a simple HTTP server (e.g., webhook-relay)

EVENT_TYPE="$1"
PAYLOAD="$2"

openclaw system event \
  --mode now \
  --text "Webhook received: $EVENT_TYPE — $PAYLOAD"
```

### CI/CD pipeline notification

```yaml
# GitHub Actions example
- name: Notify agent of deployment
  run: |
    openclaw system event \
      --mode now \
      --text "Deploy complete: ${{ github.repository }}@${{ github.sha }} deployed to production"
```

### Monitoring script

```bash
#!/bin/bash
# monitor.sh — check disk space and alert agent

USAGE=$(df -h / | awk 'NR==2 {print $5}' | tr -d '%')

if [ "$USAGE" -gt 90 ]; then
  openclaw system event \
    --mode now \
    --text "Disk usage alert: root partition at ${USAGE}% — investigate and clean up"
fi
```

### Queue non-urgent work for the next heartbeat

```bash
# Buffer events and let the agent handle them in batch
openclaw system event \
  --mode next-heartbeat \
  --text "Non-urgent: 3 new GitHub notifications since last check"
```

## Common Mistakes

<Warning>
These approaches **do not work** for programmatic agent wake-up. Use
`openclaw system event` instead.
</Warning>

| What you might try                         | Why it fails                                                  |
| ------------------------------------------ | ------------------------------------------------------------- |
| `openclaw agent --message "..."`           | Hangs indefinitely in non-interactive (script/cron) contexts. |
| Piping to stdin                            | The Gateway doesn't read agent commands from stdin.           |
| Sending directly to the chat channel       | Bypasses the Gateway; agent may not see it or may double-process. |

## How It Works

1. Your script calls `openclaw system event --text "..." --mode now`.
2. The Gateway enqueues the text as a **system event** on the main session.
3. If `--mode now`, the Gateway immediately triggers a heartbeat cycle.
4. The agent sees the event as a `System:` line in its heartbeat prompt.
5. The agent processes the event and responds (or takes action silently).

System events are **ephemeral** — they are not persisted across Gateway
restarts. If the Gateway is not running when you enqueue an event, it will be
lost.

## Combining with Cron and Heartbeat

System events work well alongside [cron jobs](/automation/cron-jobs) and
[heartbeats](/automation/cron-vs-heartbeat):

- **Cron** for scheduled, recurring tasks with precise timing.
- **Heartbeat** for periodic agent awareness (batched checks).
- **System events** for on-demand, event-driven agent triggers from external
  systems.

A common pattern is to use cron to run a lightweight gatekeeper script that
checks external APIs and only fires a system event when the agent needs to act:

```bash
# Cron runs this script every 5 minutes
# The script does cheap checks; the agent only wakes when needed
*/5 * * * * /path/to/check-and-wake.sh
```

## Related

- [CLI: `openclaw system`](/cli/system) — full CLI reference
- [Cron Jobs](/automation/cron-jobs) — scheduled task automation
- [Cron vs Heartbeat](/automation/cron-vs-heartbeat) — choosing the right mechanism
- [Webhooks](/automation/webhook) — HTTP webhook automation
