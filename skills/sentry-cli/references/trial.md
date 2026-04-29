---
name: sentry-cli-trial
version: 0.27.0
description: Manage product trials
requires:
  bins: ["sentry"]
  auth: true
---

# Trial Commands

Manage product trials

### `sentry trial list <org>`

List product trials

**JSON Fields** (use `--json --fields` to select specific fields):

| Field | Type | Description |
|-------|------|-------------|
| `category` | string | Trial category (e.g. seerUsers, seerAutofix) |
| `startDate` | string \| null | Start date (ISO 8601) |
| `endDate` | string \| null | End date (ISO 8601) |
| `reasonCode` | number | Reason code |
| `isStarted` | boolean | Whether the trial has started |
| `lengthDays` | number \| null | Trial duration in days |

### `sentry trial start <name> <org>`

Start a product trial

**Examples:**

```bash
# List all trials for the current org
sentry trial list

# List trials for a specific org
sentry trial list my-org

# Start a Seer trial
sentry trial start seer

# Start a trial for a specific org
sentry trial start replays my-org

# Start a Business plan trial (opens browser)
sentry trial start plan
```

All commands also support `--json`, `--fields`, `--help`, `--log-level`, and `--verbose` flags.
