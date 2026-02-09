---
summary: "CLI-referentie voor `openclaw approvals` (uitvoeringsgoedkeuringen voor Gateway- of node-hosts)"
read_when:
  - Je wilt uitvoeringsgoedkeuringen bewerken via de CLI
  - Je moet toegestane lijsten beheren op Gateway- of node-hosts
title: "goedkeuringen"
---

# `openclaw approvals`

Beheer uitvoeringsgoedkeuringen voor de **lokale host**, **Gateway-host** of een **node-host**.
Standaard richten opdrachten zich op het lokale goedkeuringsbestand op schijf. Gebruik `--gateway` om de Gateway te targeten, of `--node` om een specifieke node te targeten.

Gerelateerd:

- Exec approvals: [Exec approvals](/tools/exec-approvals)
- Nodes: [Nodes](/nodes)

## Veelgebruikte opdrachten

```bash
openclaw approvals get
openclaw approvals get --node <id|name|ip>
openclaw approvals get --gateway
```

## Goedkeuringen vervangen vanuit een bestand

```bash
openclaw approvals set --file ./exec-approvals.json
openclaw approvals set --node <id|name|ip> --file ./exec-approvals.json
openclaw approvals set --gateway --file ./exec-approvals.json
```

## Helpers voor toegestane lijsten

```bash
openclaw approvals allowlist add "~/Projects/**/bin/rg"
openclaw approvals allowlist add --agent main --node <id|name|ip> "/usr/bin/uptime"
openclaw approvals allowlist add --agent "*" "/usr/bin/uname"

openclaw approvals allowlist remove "~/Projects/**/bin/rg"
```

## Notities

- `--node` gebruikt dezelfde resolver als `openclaw nodes` (id, naam, ip of id-prefix).
- `--agent` staat standaard op `"*"`, wat van toepassing is op alle agents.
- De node-host moet `system.execApprovals.get/set` adverteren (macOS-app of headless node-host).
- Goedkeuringsbestanden worden per host opgeslagen op `~/.openclaw/exec-approvals.json`.
