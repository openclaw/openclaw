---
summary: "OAG runtime surfaces for channel backlog, session watchdog, and task watch"
read_when:
  - You see OAG lines in `openclaw status`, `openclaw health`, or `doctor`
  - You need to debug channel backlog recovery or stalled session/task follow-ups
title: "OAG Runtime"
---

# OAG Runtime

OAG is the runtime layer that watches delivery backlog, stalled sessions, and stuck task follow-ups around the Gateway and agent loop.

Current OAG surfaces in this repo:

- `openclaw status` prints `OAG channels`, `OAG sessions`, and `OAG tasks` in the overview.
- `openclaw health` and `doctor` include the same OAG summaries when the Gateway is healthy enough to answer probes.
- Session replies can receive one-shot `OAG:` system notes when the runtime performs a recovery action that the user should know about.
- For external audits or tool-assisted review, use [OAG Review Brief](/gateway/oag-review-brief).
- For a more formal requirements/progress/checklist document, use [OAG Plan](/gateway/oag-plan).

## Where state lives

OAG channel and watch state is read from:

```text
~/.openclaw/sentinel/channel-health-state.json
```

This file is produced by the sentinel/watch pipeline and then consumed by CLI status surfaces plus session/system-note formatting.

## What the three OAG lines mean

### `OAG channels`

Summarizes outbound delivery pressure and channel recovery.

Common states:

- `clear`: no active backlog pressure is being tracked
- `congested`: pending deliveries and recent failures are rising; OAG is trying to contain pressure
- `recovering backlog`: channel connectivity recovered, but queued deliveries are still draining
- `backlog prolonged`: backlog remained after recovery long enough that OAG recommends a gateway restart

Signals shown in the line may include:

- pending delivery count
- recent failure count
- backlog age in minutes
- last automated action such as verification or gateway restart

### `OAG sessions`

Summarizes watchdog activity for reply sessions that look stalled or blocked by runtime/model failures.

Common states:

- `clear`: no active session watchdog intervention
- `watching N sessions`: OAG sees stalled sessions and is nudging the mainline back into the active task
- `blocked by model/runtime errors`: the watchdog is active but repeated failures are preventing clean recovery

### `OAG tasks`

Summarizes stuck follow-up tasks, especially when a task appears complete but the runtime has not resolved the mainline.

Common states:

- `clear`: no active task watch
- `<followupType> · step X/Y · Nm`: OAG sees a running follow-up that has not advanced recently
- `terminal step still running`: the task reached a final-looking step but never resolved cleanly

## Recovery behavior tied to OAG

The current branch wires OAG-related recovery into several paths:

- When a channel becomes operational again, the Gateway replays queued outbound deliveries for that channel/account.
- Channel monitors publish connected/disconnected and inbound-activity status so health policy can distinguish a dead socket from a quiet but healthy channel.
- Heartbeat and session updates can localize OAG user-visible notes based on the session’s recent reply language.

## Basic troubleshooting flow

1. Run `openclaw status` for a quick local readout.
2. If OAG lines are not `clear`, run `openclaw health --json` to inspect the live Gateway snapshot.
3. Open `~/.openclaw/sentinel/channel-health-state.json` and confirm the tracked channel/account/session entries match the failing path.
4. If `OAG channels` reports prolonged backlog after recovery, restart the Gateway and watch whether pending deliveries drain.
5. If `OAG sessions` stays blocked by runtime/model errors, inspect the affected session transcript and recent agent/gateway logs before retrying.

## What is still light on documentation

The code now exposes OAG runtime state, but these parts are still intentionally thin and mostly for maintainers:

- the exact sentinel producer schema and how it is authored
- the full lifecycle for Argus recovery metadata in session stores
- automatic note localization heuristics for user-visible recovery messages

If those surfaces keep growing, split them into dedicated docs rather than expanding the generic CLI pages further.

## Configuration

OAG behavior can be tuned through the `gateway.oag` configuration section. All values are optional — sensible defaults are used when absent.

### Delivery recovery

| Key                                     | Type   | Default | Description                                                                                                                                 |
| --------------------------------------- | ------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `gateway.oag.delivery.maxRetries`       | number | `5`     | Maximum retry attempts for a queued delivery before moving it to the failed directory.                                                      |
| `gateway.oag.delivery.recoveryBudgetMs` | number | `60000` | Maximum wall-clock time (ms) for delivery recovery on startup or after channel reconnect. Remaining entries are deferred to the next cycle. |

### File lock

| Key                          | Type   | Default | Description                                                                                  |
| ---------------------------- | ------ | ------- | -------------------------------------------------------------------------------------------- |
| `gateway.oag.lock.timeoutMs` | number | `2000`  | Maximum time (ms) to wait for the OAG state file lock before giving up.                      |
| `gateway.oag.lock.staleMs`   | number | `30000` | Age threshold (ms) for considering a lock file stale. Stale locks are automatically cleared. |

### Health policy

| Key                                  | Type   | Default | Description                                                                                                                                                                                                          |
| ------------------------------------ | ------ | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gateway.oag.health.stalePollFactor` | number | `2`     | Multiplier applied to `staleEventThresholdMs` for polling and webhook channels. A factor of `2` means Telegram and webhook channels use a 60-minute stale threshold when the default socket threshold is 30 minutes. |

### Notes

| Key                                     | Type   | Default | Description                                                                                                  |
| --------------------------------------- | ------ | ------- | ------------------------------------------------------------------------------------------------------------ |
| `gateway.oag.notes.dedupWindowMs`       | number | `60000` | Time window (ms) for deduplicating recovery notes with the same action. Set to `0` to disable deduplication. |
| `gateway.oag.notes.maxDeliveredHistory` | number | `20`    | Maximum number of delivered notes kept in the audit trail. Oldest entries are pruned first.                  |

### Example

```json
{
  "gateway": {
    "oag": {
      "delivery": {
        "maxRetries": 8,
        "recoveryBudgetMs": 120000
      },
      "health": {
        "stalePollFactor": 3
      },
      "notes": {
        "dedupWindowMs": 0
      }
    }
  }
}
```

Changes to `gateway.oag` take effect at call time without a gateway restart. Use `openclaw config set gateway.oag.delivery.maxRetries 8` for individual values, or edit `~/.openclaw/config.json` directly and the gateway config reloader will pick up the changes.
