---
summary: "CLI-Referenz für `openclaw browser` (Profile, Tabs, Aktionen, Extension-Relay)"
read_when:
  - Sie verwenden `openclaw browser` und möchten Beispiele für häufige Aufgaben
  - Sie möchten einen Browser steuern, der auf einer anderen Maschine über einen Node-Host läuft
  - Sie möchten das Chrome-Extension-Relay verwenden (Anhängen/Trennen über die Toolbar-Schaltfläche)
title: "browser"
---

# `openclaw browser`

Verwalten Sie OpenClaws Browser-Control-Server und führen Sie Browseraktionen aus (Tabs, Snapshots, Screenshots, Navigation, Klicks, Tippen).

Verwandt:

- Browser-Werkzeug + API: [Browser tool](/tools/browser)
- Chrome-Extension-Relay: [Chrome extension](/tools/chrome-extension)

## Common flags

- `--url <gatewayWsUrl>`: Gateway-WebSocket-URL (Standard aus der Konfiguration).
- `--token <token>`: Gateway-Token (falls erforderlich).
- `--timeout <ms>`: Request-Timeout (ms).
- `--browser-profile <name>`: Browserprofil auswählen (Standard aus der Konfiguration).
- `--json`: maschinenlesbare Ausgabe (wo unterstützt).

## Schnellstart (lokal)

```bash
openclaw browser --browser-profile chrome tabs
openclaw browser --browser-profile openclaw start
openclaw browser --browser-profile openclaw open https://example.com
openclaw browser --browser-profile openclaw snapshot
```

## Profile

Profile sind benannte Browser-Routing-Konfigurationen. In der Praxis:

- `openclaw`: startet/verbinden sich mit einer dedizierten, von OpenClaw verwalteten Chrome-Instanz (isoliertes Benutzer-Datenverzeichnis).
- `chrome`: steuert Ihre bestehenden Chrome-Tabs über das Chrome-Extension-Relay.

```bash
openclaw browser profiles
openclaw browser create-profile --name work --color "#FF5A36"
openclaw browser delete-profile --name work
```

Ein bestimmtes Profil verwenden:

```bash
openclaw browser --browser-profile work tabs
```

## Tabs

```bash
openclaw browser tabs
openclaw browser open https://docs.openclaw.ai
openclaw browser focus <targetId>
openclaw browser close <targetId>
```

## Snapshot / Screenshot / Aktionen

Snapshot:

```bash
openclaw browser snapshot
```

Screenshot:

```bash
openclaw browser screenshot
```

Navigieren/Klicken/Tippen (referenzbasierte UI-Automatisierung):

```bash
openclaw browser navigate https://example.com
openclaw browser click <ref>
openclaw browser type <ref> "hello"
```

## Chrome-Extension-Relay (Anhängen über die Toolbar-Schaltfläche)

Dieser Modus ermöglicht es dem Agenten, einen bestehenden Chrome-Tab zu steuern, den Sie manuell anhängen (keine automatische Anbindung).

Installieren Sie die entpackte Extension in einen stabilen Pfad:

```bash
openclaw browser extension install
openclaw browser extension path
```

Dann Chrome → `chrome://extensions` → „Developer mode“ aktivieren → „Load unpacked“ → den ausgegebenen Ordner auswählen.

Vollständige Anleitung: [Chrome extension](/tools/chrome-extension)

## Remote-Browsersteuerung (Node-Host-Proxy)

Wenn der Gateway auf einer anderen Maschine als der Browser läuft, starten Sie einen **Node-Host** auf der Maschine mit Chrome/Brave/Edge/Chromium. Der Gateway leitet Browseraktionen an diesen Node weiter (kein separater Browser-Control-Server erforderlich).

Verwenden Sie `gateway.nodes.browser.mode`, um das automatische Routing zu steuern, und `gateway.nodes.browser.node`, um einen bestimmten Node festzulegen, wenn mehrere verbunden sind.

Sicherheit + Remote-Einrichtung: [Browser tool](/tools/browser), [Remote access](/gateway/remote), [Tailscale](/gateway/tailscale), [Security](/gateway/security)
