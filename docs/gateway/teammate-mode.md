---
summary: "Teammate mode: persistent worker computer, named Bots, exec off the gateway"
read_when:
  - You want OpenClaw to ship as a teammate with a durable worker disk
  - You are splitting Gateway from exec on Coolify or a VPS
  - You are naming Bots and routing @mentions
title: Teammate mode
status: active
---

# Teammate mode

Closing Control UI does not stop a turn or a routine; the worker disk is the
computer.

`openclaw init --mode teammate` is **opt-in**. It does not rewrite an existing
gateway-as-computer install.

## Two shapes

| Shape | What it is |
| --- | --- |
| Coolify gateway-is-computer | Gateway, exec, browser, and disk share one host. Fine for a laptop-shaped box. |
| True split | Gateway can stay on a cheap VPS. Exec, browser, and `/home/bot` live on the long-lived worker. |

The generated `$STATE/teammate/README.md` and `docker-compose.teammate.yml`
overlay describe the split. Worker disk:

| Path | Role |
| --- | --- |
| `$STATE/teammate/home` | Durable workspace mounted at `/home/bot` |
| `$STATE/teammate/home/.browser` | Browser profile (logins, cookies) |

Secrets stay SecretRef-oriented. Do not paste tokens into MEMORY.md or chat.

## Named Bots

Create Researcher, Writer, and Ops as agents. Give each `identity.title` and
`identity.job`. `identity.theme` stays a **project label** (AXWEL, Procurement)
— never a mention slogan.

Unique `@Researcher` / `@axwel-backend` mentions in Slack, Telegram, WhatsApp,
Signal, and Discord select that Bot before channel-wide bindings. Peer-specific
bindings still win.

## Approvals and return-control

Send, pay, publish, delete, and production stay behind approval cards. Taking
control of the live desktop does not steal the turn; **Return control to agent**
hands the worker back without stopping the routine.

## Follow-along

`/follow-along start` records live UI work on the worker. After two successful
skill compiles, `/follow-along schedule` binds a weekday automations job to
**this Bot + this conversation** (`sessionTarget: "current"`), not an orphan
cron.

## Confirm exec placement

```bash
openclaw sandbox explain --json
openclaw security audit
```

A teammate install whose exec host drifted onto the gateway emits critical
`teammate.exec_on_gateway`.
