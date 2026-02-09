---
summary: "CLI-Referenz für `openclaw node` (headless Node-Host)"
read_when:
  - Beim Ausführen des headless Node-Hosts
  - Beim Koppeln eines Nicht-macOS-Nodes für system.run
title: "node"
---

# `openclaw node`

Führen Sie einen **headless Node-Host** aus, der sich mit dem Gateway-WebSocket verbindet und
`system.run` / `system.which` auf dieser Maschine bereitstellt.

## Warum einen Node-Host verwenden?

Verwenden Sie einen Node-Host, wenn Sie möchten, dass Agenten **Befehle auf anderen Maschinen** in Ihrem
Netzwerk ausführen, ohne dort eine vollständige macOS-Companion-App zu installieren.

Häufige Anwendungsfälle:

- Ausführen von Befehlen auf entfernten Linux-/Windows-Rechnern (Build-Server, Laborrechner, NAS).
- **Sandboxed** Exec auf dem Gateway beibehalten, aber genehmigte Ausführungen an andere Hosts delegieren.
- Bereitstellung eines schlanken, headless Ausführungsziels für Automatisierung oder CI-Nodes.

Die Ausführung wird weiterhin durch **Exec-Genehmigungen** und agentenspezifische Allowlists auf dem
Node-Host abgesichert, sodass der Befehlszugriff klar abgegrenzt und explizit bleibt.

## Browser-Proxy (Zero-Config)

Node-Hosts bewerben automatisch einen Browser-Proxy, wenn `browser.enabled` auf dem Node nicht
deaktiviert ist. Dadurch kann der Agent Browser-Automatisierung auf diesem Node ohne zusätzliche
Konfiguration nutzen.

Deaktivieren Sie ihn bei Bedarf auf dem Node:

```json5
{
  nodeHost: {
    browserProxy: {
      enabled: false,
    },
  },
}
```

## Ausführen (Vordergrund)

```bash
openclaw node run --host <gateway-host> --port 18789
```

Optionen:

- `--host <host>`: Gateway-WebSocket-Host (Standard: `127.0.0.1`)
- `--port <port>`: Gateway-WebSocket-Port (Standard: `18789`)
- `--tls`: TLS für die Gateway-Verbindung verwenden
- `--tls-fingerprint <sha256>`: Erwarteter TLS-Zertifikatsfingerabdruck (sha256)
- `--node-id <id>`: Node-ID überschreiben (löscht Pairing-Token)
- `--display-name <name>`: Anzeigenamen des Nodes überschreiben

## Dienst (Hintergrund)

Installieren Sie einen headless Node-Host als Benutzerdienst.

```bash
openclaw node install --host <gateway-host> --port 18789
```

Optionen:

- `--host <host>`: Gateway-WebSocket-Host (Standard: `127.0.0.1`)
- `--port <port>`: Gateway-WebSocket-Port (Standard: `18789`)
- `--tls`: TLS für die Gateway-Verbindung verwenden
- `--tls-fingerprint <sha256>`: Erwarteter TLS-Zertifikatsfingerabdruck (sha256)
- `--node-id <id>`: Node-ID überschreiben (löscht Pairing-Token)
- `--display-name <name>`: Anzeigenamen des Nodes überschreiben
- `--runtime <runtime>`: Laufzeit des Dienstes (`node` oder `bun`)
- `--force`: Neu installieren/überschreiben, falls bereits installiert

Dienst verwalten:

```bash
openclaw node status
openclaw node stop
openclaw node restart
openclaw node uninstall
```

Verwenden Sie `openclaw node run` für einen Node-Host im Vordergrund (kein Dienst).

Dienstbefehle akzeptieren `--json` für maschinenlesbare Ausgabe.

## Pairing

Die erste Verbindung erstellt eine ausstehende Node-Pairing-Anfrage auf dem Gateway.
Genehmigen Sie sie über:

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
```

Der Node-Host speichert seine Node-ID, sein Token, den Anzeigenamen und die
Gateway-Verbindungsinformationen in
`~/.openclaw/node.json`.

## Exec-Genehmigungen

`system.run` ist durch lokale Exec-Genehmigungen abgesichert:

- `~/.openclaw/exec-approvals.json`
- [Exec approvals](/tools/exec-approvals)
- `openclaw approvals --node <id|name|ip>` (Bearbeitung über das Gateway)
