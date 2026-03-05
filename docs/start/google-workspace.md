---
summary: "All Google Workspace integration paths — skill CLIs, MCP server, Gmail hooks, and Google Chat channel"
read_when:
  - Connecting Gmail, Calendar, Drive, or other Google services to your agent
  - Choosing between gog and gws
  - Setting up Google Workspace automation
title: "Google Workspace"
---

# Google Workspace

OpenClaw supports Google Workspace through multiple integration paths: skill CLIs for on-demand tool calls, Gmail Pub/Sub hooks for event-driven automation, and a Google Chat channel for two-way messaging. This page helps you pick the right one.

## Which integration is right for you?

| Goal                                                              | Integration                              | Setup effort |
| ----------------------------------------------------------------- | ---------------------------------------- | ------------ |
| Agent reads/writes Gmail, Calendar, Drive, Sheets, Docs, Contacts | `gws` skill (recommended) or `gog` skill | Low          |
| Agent manages Chat, Tasks, Meet, Forms, Slides, Keep, Admin, etc. | `gws` skill                              | Low          |
| Agent reacts to new emails automatically                          | Gmail Pub/Sub hooks                      | Medium       |
| Agent receives messages in Google Chat                            | Google Chat channel                      | Medium       |

## Option 1: gws skill (recommended)

[gws](https://github.com/nicholasgasior/gws) is the official Google Workspace CLI. It covers **all 6 services** that `gog` supports (Gmail, Calendar, Drive, Contacts, Sheets, Docs) **plus 12+ more** including Admin, Tasks, Chat, Meet, Forms, Slides, Keep, Classroom, Vault, Cloud Identity, Apps Script, and Alert Center.

### Install

```bash
npm i -g @googleworkspace/cli
```

### Authenticate

```bash
gws auth setup
```

Follow the prompts to authorize your Google account.

### Verify

```bash
gws gmail users.messages.list --max 3
```

You should see your three most recent Gmail messages.

### MCP server mode

`gws` can also run as an MCP server, exposing selected services directly to your agent:

```bash
gws mcp -s drive,gmail,calendar
```

See the [Skills](/tools/skills) docs for how OpenClaw discovers and uses skill CLIs.

## Option 2: gog skill

If you already have `gog` installed via Homebrew, it works as-is — no migration required. `gog` covers Gmail, Calendar, Drive, Contacts, Sheets, and Docs.

```bash
brew install nicholasgasior/tools/gog
gog auth setup
```

Note that `gws` is a strict superset of `gog`. If you're starting fresh, use `gws` instead.

See [gogcli.sh](https://gogcli.sh/) for full documentation.

## Gmail Pub/Sub hooks

Gmail Pub/Sub hooks let your agent react to new emails automatically — for example, triaging incoming mail or drafting replies as messages arrive.

This requires a Google Cloud project with Pub/Sub configured and a public HTTPS endpoint (Tailscale Funnel is the supported option).

The Gmail hook currently requires `gog`. Support for `gws` as the underlying CLI is coming.

See the full setup guide at [Gmail PubSub](/automation/gmail-pubsub).

## Google Chat channel

The Google Chat channel lets your agent receive and respond to messages directly in Google Chat — both DMs and spaces.

This requires a Google Cloud project with the Chat API enabled and a service account.

See the full setup guide at [Google Chat](/channels/googlechat).

## What each path gives you

- **Skill CLIs** (`gws` / `gog`) — on-demand tool calls. Your agent invokes Gmail, Calendar, Drive, etc. as needed during a conversation. Best for interactive use.
- **Gmail Pub/Sub hooks** — event-driven automation. Your agent wakes up when a new email arrives and takes action without being asked. Best for inbox triage, auto-replies, and workflows.
- **Google Chat channel** — two-way chat surface. Users message your agent in Google Chat and get responses there. Best for team-facing assistants.

These paths complement each other. A typical setup might use `gws` for on-demand Google API calls, Gmail hooks for automatic email triage, and Google Chat as an additional messaging surface.

## Related docs

- [Skills](/tools/skills) — how OpenClaw discovers and uses skill CLIs
- [Skills config](/tools/skills-config) — configuring skill behavior
- [Gmail PubSub](/automation/gmail-pubsub) — full Gmail hook setup
- [Google Chat](/channels/googlechat) — full Google Chat channel setup
- [Hooks](/automation/hooks) — webhook automation overview
- [Cron jobs](/automation/cron-jobs) — scheduled automation
