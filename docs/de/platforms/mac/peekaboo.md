---
summary: "„PeekabooBridge-Integration für macOS-UI-Automatisierung“"
read_when:
  - „Hosting von PeekabooBridge in OpenClaw.app“
  - „Integration von Peekaboo über Swift Package Manager“
  - „Ändern des PeekabooBridge-Protokolls bzw.
title: "„Peekaboo Bridge“"
---

# Peekaboo Bridge (macOS-UI-Automatisierung)

OpenClaw kann **PeekabooBridge** als lokalen, berechtigungsbewussten Broker für UI-Automatisierung hosten. Dadurch kann die `peekaboo` CLI die UI-Automatisierung steuern und dabei die TCC-Berechtigungen der macOS-App wiederverwenden.

## Was das ist (und was nicht)

- **Host**: OpenClaw.app kann als PeekabooBridge-Host fungieren.
- **Client**: Verwenden Sie die `peekaboo` CLI (keine separate `openclaw ui ...`-Oberfläche).
- **UI**: Visuelle Overlays verbleiben in Peekaboo.app; OpenClaw ist ein schlanker Broker-Host.

## Bridge aktivieren

In der macOS-App:

- Einstellungen → **Peekaboo Bridge aktivieren**

Wenn aktiviert, startet OpenClaw einen lokalen UNIX-Socket-Server. Wenn deaktiviert, wird der Host gestoppt und `peekaboo` greift auf andere verfügbare Hosts zurück.

## Reihenfolge der Client-Erkennung

Peekaboo-Clients versuchen Hosts typischerweise in dieser Reihenfolge:

1. Peekaboo.app (vollständige UX)
2. Claude.app (falls installiert)
3. OpenClaw.app (schlanker Broker)

Verwenden Sie `peekaboo bridge status --verbose`, um zu sehen, welcher Host aktiv ist und welcher
Socket-Pfad verwendet wird. Sie können dies überschreiben mit:

```bash
export PEEKABOO_BRIDGE_SOCKET=/path/to/bridge.sock
```

## Sicherheit & Berechtigungen

- Die Bridge validiert **Code-Signaturen der Aufrufer**; eine Allowlist von TeamIDs wird durchgesetzt (Peekaboo-Host-TeamID + OpenClaw-App-TeamID).
- Anfragen laufen nach ca. 10 Sekunden ab.
- Wenn erforderliche Berechtigungen fehlen, gibt die Bridge eine klare Fehlermeldung zurück, anstatt die Systemeinstellungen zu öffnen.

## Snapshot-Verhalten (Automatisierung)

Snapshots werden im Speicher abgelegt und verfallen automatisch nach kurzer Zeit.
Wenn Sie eine längere Aufbewahrung benötigen, erfassen Sie diese erneut vom Client aus.

## Fehlerbehebung

- Wenn `peekaboo` „bridge client is not authorized“ meldet, stellen Sie sicher, dass der Client korrekt signiert ist, oder führen Sie den Host mit `PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1` nur im **Debug**-Modus aus.
- Wenn keine Hosts gefunden werden, öffnen Sie eine der Host-Apps (Peekaboo.app oder OpenClaw.app) und bestätigen Sie, dass die Berechtigungen erteilt sind.
