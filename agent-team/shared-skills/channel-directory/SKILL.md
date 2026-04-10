---
name: channel_directory
description: Look up the Slack channel ID for a named channel before sending or reading with the `message` tool. Trigger on any Slack post/read where only the `#channel-name` is known.
---

# Channel Directory

Use this skill to look up Slack channel IDs. The `message` tool needs channel IDs, not `#names`. Always refer to channels by `#name` in human-readable text, but pass the ID to the tool.

## Channels

| Channel | ID | Canonical owner |
|---------|-----|---|
| `#dispatch` | `C0APBP8JJSX` | Orchestrator |
| `#research` | `C0APEJD4JSZ` | Analyst |
| `#quant-signals` | `C0APBNWUTGB` | Quant |
| `#portfolio-daily` | `C0APBP5MS4B` | Orchestrator (canonical decisions) |
| `#portfolio-weekly` | `C0AQCD7Q1U0` | Orchestrator |
| `#contrarian` | `C0APX22FG9X` | Devil's Advocate |
| `#market-signals` | `C0APJ5GE8Q2` | Scout |
| `#agents` | `C0APH5991U2` | any |
| `#themes` | `C0AP4KWHXQF` | any |
| `#watchlist` | `${SLACK_CHANNEL_WATCHLIST}` | Orchestrator canonical + Scout morning build |
| `#weekly-outlook` | `${SLACK_CHANNEL_WEEKLY_OUTLOOK}` | Scout |

## Usage

Send:

```
message(action: "send", target: "C0APEJD4JSZ", text: "...")
```

Read:

```
message(action: "read", channel: "C0APJ5GE8Q2")
```

## Canonical state channels (read on startup)

- `#watchlist` — current active coverage list. Read the last ~20 messages on startup.
- `#portfolio-daily` — most recent portfolio decisions. Read the last ~10 messages on startup.

These channels replace the old `shared/portfolio/watchlist.md` and `shared/portfolio/recent-decisions.md` files.
