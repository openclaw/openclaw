---
summary: "CLI-reference for `openclaw approvals` (exec-godkendelser for gateway- eller node-værter)"
read_when:
  - Du vil redigere exec-godkendelser fra CLI
  - Du skal administrere tilladelseslister på gateway- eller node-værter
title: "godkendelser"
---

# `openclaw approvals`

Administrer exec godkendelser for den **lokale vært**, **gateway vært**, eller en **node vært**.
Kommandoer som standard målretter den lokale godkendelsesfil på disken. Brug `-- gateway` for at målrette gatewayen, eller `-- node` for at målrette en bestemt knude.

Relateret:

- Exec-godkendelser: [Exec approvals](/tools/exec-approvals)
- Noder: [Nodes](/nodes)

## Almindelige kommandoer

```bash
openclaw approvals get
openclaw approvals get --node <id|name|ip>
openclaw approvals get --gateway
```

## Erstat godkendelser fra en fil

```bash
openclaw approvals set --file ./exec-approvals.json
openclaw approvals set --node <id|name|ip> --file ./exec-approvals.json
openclaw approvals set --gateway --file ./exec-approvals.json
```

## Hjælpere til tilladelsesliste

```bash
openclaw approvals allowlist add "~/Projects/**/bin/rg"
openclaw approvals allowlist add --agent main --node <id|name|ip> "/usr/bin/uptime"
openclaw approvals allowlist add --agent "*" "/usr/bin/uname"

openclaw approvals allowlist remove "~/Projects/**/bin/rg"
```

## Noter

- `--node` bruger den samme resolver som `openclaw nodes` (id, navn, ip eller id-præfiks).
- `--agent` er som standard `"*"`, hvilket gælder for alle agenter.
- Node-værten skal annoncere `system.execApprovals.get/set` (macOS-app eller headless node-vært).
- Godkendelsesfiler gemmes pr. vært på `~/.openclaw/exec-approvals.json`.
