---
summary: "CLI-Referenz für `openclaw approvals` (Exec-Freigaben für Gateway- oder Node-Hosts)"
read_when:
  - Sie möchten Exec-Freigaben über die CLI bearbeiten
  - Sie müssen Allowlists auf Gateway- oder Node-Hosts verwalten
title: "approvals"
---

# `openclaw approvals`

Verwalten Sie Exec-Freigaben für den **lokalen Host**, den **Gateway-Host** oder einen **Node-Host**.
Standardmäßig zielen Befehle auf die lokale Freigabedatei auf dem Datenträger. Verwenden Sie `--gateway`, um das Gateway anzusprechen, oder `--node`, um einen bestimmten Node anzusprechen.

Verwandt:

- Exec-Freigaben: [Exec approvals](/tools/exec-approvals)
- Nodes: [Nodes](/nodes)

## Häufige Befehle

```bash
openclaw approvals get
openclaw approvals get --node <id|name|ip>
openclaw approvals get --gateway
```

## Freigaben aus einer Datei ersetzen

```bash
openclaw approvals set --file ./exec-approvals.json
openclaw approvals set --node <id|name|ip> --file ./exec-approvals.json
openclaw approvals set --gateway --file ./exec-approvals.json
```

## Allowlist-Helfer

```bash
openclaw approvals allowlist add "~/Projects/**/bin/rg"
openclaw approvals allowlist add --agent main --node <id|name|ip> "/usr/bin/uptime"
openclaw approvals allowlist add --agent "*" "/usr/bin/uname"

openclaw approvals allowlist remove "~/Projects/**/bin/rg"
```

## Hinweise

- `--node` verwendet denselben Resolver wie `openclaw nodes` (ID, Name, IP oder ID-Präfix).
- `--agent` ist standardmäßig auf `"*"` gesetzt, was für alle Agents gilt.
- Der Node-Host muss `system.execApprovals.get/set` ankündigen (macOS-App oder Headless-Node-Host).
- Freigabedateien werden pro Host unter `~/.openclaw/exec-approvals.json` gespeichert.
