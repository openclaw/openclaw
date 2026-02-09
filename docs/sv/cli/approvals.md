---
summary: "CLI-referens för `openclaw approvals` (exec-godkännanden för Gateway eller nodvärdar)"
read_when:
  - Du vill redigera exec-godkännanden från CLI
  - Du behöver hantera tillåtelselistor på Gateway- eller nodvärdar
title: "godkännanden"
---

# `openclaw approvals`

Hantera exec godkännanden för **lokal värd**, **gateway värd**, eller en **nod värd**.
Som standard riktar kommandon den lokala godkännandefilen på disken. Använd `--gateway` för att rikta gateway, eller `--node` för att rikta en specifik nod.

Relaterat:

- Exec-godkännanden: [Exec approvals](/tools/exec-approvals)
- Noder: [Nodes](/nodes)

## Vanliga kommandon

```bash
openclaw approvals get
openclaw approvals get --node <id|name|ip>
openclaw approvals get --gateway
```

## Ersätt godkännanden från en fil

```bash
openclaw approvals set --file ./exec-approvals.json
openclaw approvals set --node <id|name|ip> --file ./exec-approvals.json
openclaw approvals set --gateway --file ./exec-approvals.json
```

## Hjälpverktyg för tillåtelselista

```bash
openclaw approvals allowlist add "~/Projects/**/bin/rg"
openclaw approvals allowlist add --agent main --node <id|name|ip> "/usr/bin/uptime"
openclaw approvals allowlist add --agent "*" "/usr/bin/uname"

openclaw approvals allowlist remove "~/Projects/**/bin/rg"
```

## Noteringar

- `--node` använder samma resolver som `openclaw nodes` (id, namn, ip eller id-prefix).
- `--agent` använder som standard `"*"`, vilket gäller för alla agenter.
- Nodvärden måste annonsera `system.execApprovals.get/set` (macOS-app eller headless nodvärd).
- Godkännandefiler lagras per värd på `~/.openclaw/exec-approvals.json`.
