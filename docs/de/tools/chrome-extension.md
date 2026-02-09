---
summary: "Chrome-Erweiterung: Lassen Sie OpenClaw Ihren bestehenden Chrome-Tab steuern"
read_when:
  - Sie möchten, dass der Agent einen bestehenden Chrome-Tab steuert (Toolbar-Schaltfläche)
  - Sie benötigen ein Remote-Gateway + lokale Browser-Automatisierung über Tailscale
  - Sie möchten die Sicherheitsimplikationen einer Browser-Übernahme verstehen
title: "Chrome-Erweiterung"
---

# Chrome-Erweiterung (Browser-Relay)

Die OpenClaw-Chrome-Erweiterung ermöglicht es dem Agenten, Ihre **bestehenden Chrome-Tabs** (Ihr normales Chrome-Fenster) zu steuern, anstatt ein separates, von OpenClaw verwaltetes Chrome-Profil zu starten.

Das An- und Abkoppeln erfolgt über **eine einzelne Chrome-Toolbar-Schaltfläche**.

## Was es ist (Konzept)

Es gibt drei Teile:

- **Browser-Control-Service** (Gateway oder Node): die API, die der Agent/das Werkzeug aufruft (über das Gateway)
- **Lokaler Relay-Server** (Loopback-CDP): verbindet den Control-Server mit der Erweiterung (`http://127.0.0.1:18792` standardmäßig)
- **Chrome-MV3-Erweiterung**: koppelt sich an den aktiven Tab mittels `chrome.debugger` an und leitet CDP-Nachrichten an das Relay weiter

OpenClaw steuert den angekoppelten Tab anschließend über die normale `browser`-Werkzeugoberfläche (unter Auswahl des richtigen Profils).

## Installieren / Laden (unpacked)

1. Installieren Sie die Erweiterung in einen stabilen lokalen Pfad:

```bash
openclaw browser extension install
```

2. Geben Sie den installierten Verzeichnispfad der Erweiterung aus:

```bash
openclaw browser extension path
```

3. Chrome → `chrome://extensions`

- „Developer mode“ aktivieren
- „Load unpacked“ → das oben ausgegebene Verzeichnis auswählen

4. Heften Sie die Erweiterung an.

## Updates (kein Build-Schritt)

Die Erweiterung wird innerhalb des OpenClaw-Releases (npm-Paket) als statische Dateien ausgeliefert. Es gibt keinen separaten „Build“-Schritt.

Nach dem Upgrade von OpenClaw:

- Führen Sie `openclaw browser extension install` erneut aus, um die installierten Dateien unter Ihrem OpenClaw-State-Verzeichnis zu aktualisieren.
- Chrome → `chrome://extensions` → klicken Sie bei der Erweiterung auf „Reload“.

## Verwendung (keine zusätzliche Konfiguration)

OpenClaw wird mit einem integrierten Browser-Profil namens `chrome` ausgeliefert, das auf das Extension-Relay auf dem Standardport abzielt.

Verwendung:

- CLI: `openclaw browser --browser-profile chrome tabs`
- Agent-Werkzeug: `browser` mit `profile="chrome"`

Wenn Sie einen anderen Namen oder einen anderen Relay-Port möchten, erstellen Sie Ihr eigenes Profil:

```bash
openclaw browser create-profile \
  --name my-chrome \
  --driver extension \
  --cdp-url http://127.0.0.1:18792 \
  --color "#00AA00"
```

## An- / Abkoppeln (Toolbar-Schaltfläche)

- Öffnen Sie den Tab, den OpenClaw steuern soll.
- Klicken Sie auf das Erweiterungssymbol.
  - Das Badge zeigt `ON` an, wenn angekoppelt.
- Klicken Sie erneut, um zu entkoppeln.

## Welchen Tab steuert es?

- Es steuert **nicht** automatisch „den Tab, den Sie gerade ansehen“.
- Es steuert **nur die Tabs, die Sie explizit angekoppelt haben**, indem Sie auf die Toolbar-Schaltfläche klicken.
- Zum Wechseln: Öffnen Sie den anderen Tab und klicken Sie dort auf das Erweiterungssymbol.

## Badge + häufige Fehler

- `ON`: angekoppelt; OpenClaw kann diesen Tab steuern.
- `…`: Verbindung zum lokalen Relay wird hergestellt.
- `!`: Relay nicht erreichbar (am häufigsten: der Browser-Relay-Server läuft auf dieser Maschine nicht).

Wenn Sie `!` sehen:

- Stellen Sie sicher, dass das Gateway lokal läuft (Standardeinrichtung), oder starten Sie einen Node-Host auf dieser Maschine, wenn das Gateway woanders läuft.
- Öffnen Sie die Options-Seite der Erweiterung; dort wird angezeigt, ob das Relay erreichbar ist.

## Remote-Gateway (Node-Host verwenden)

### Lokales Gateway (gleiche Maschine wie Chrome) — in der Regel **keine zusätzlichen Schritte**

Wenn das Gateway auf derselben Maschine wie Chrome läuft, startet es den Browser-Control-Service auf local loopback
und startet den Relay-Server automatisch. Die Erweiterung spricht mit dem lokalen Relay; die CLI-/Werkzeug-Aufrufe gehen an das Gateway.

### Remote-Gateway (Gateway läuft woanders) — **Node-Host ausführen**

Wenn Ihr Gateway auf einer anderen Maschine läuft, starten Sie einen Node-Host auf der Maschine, auf der Chrome läuft.
Das Gateway proxyt Browser-Aktionen zu diesem Node; die Erweiterung + das Relay bleiben lokal auf der Browser-Maschine.

Wenn mehrere Nodes verbunden sind, fixieren Sie einen mit `gateway.nodes.browser.node` oder setzen Sie `gateway.nodes.browser.mode`.

## Sandboxing (Werkzeug-Container)

Wenn Ihre Agent-Sitzung sandboxed ist (`agents.defaults.sandbox.mode != "off"`), kann das `browser`-Werkzeug eingeschränkt sein:

- Standardmäßig zielen sandboxed Sitzungen häufig auf den **Sandbox-Browser** (`target="sandbox"`), nicht auf Ihren Host-Chrome.
- Die Übernahme über das Chrome-Erweiterungs-Relay erfordert die Kontrolle des **Host**-Browser-Control-Servers.

Optionen:

- Am einfachsten: Verwenden Sie die Erweiterung aus einer **nicht sandboxed** Sitzung/einem Agenten.
- Oder erlauben Sie Host-Browser-Kontrolle für sandboxed Sitzungen:

```json5
{
  agents: {
    defaults: {
      sandbox: {
        browser: {
          allowHostControl: true,
        },
      },
    },
  },
}
```

Stellen Sie anschließend sicher, dass das Werkzeug nicht durch die Werkzeugrichtlinie verweigert wird, und rufen Sie (falls nötig) `browser` mit `target="host"` auf.

Debugging: `openclaw sandbox explain`

## Tipps für den Remote-Zugriff

- Halten Sie Gateway und Node-Host im selben Tailnet; vermeiden Sie es, Relay-Ports ins LAN oder ins öffentliche Internet zu exponieren.
- Koppeln Sie Nodes gezielt; deaktivieren Sie Browser-Proxy-Routing, wenn Sie keine Fernsteuerung wünschen (`gateway.nodes.browser.mode="off"`).

## Wie der „Extension Path“ funktioniert

`openclaw browser extension path` gibt das **installierte** On-Disk-Verzeichnis aus, das die Erweiterungsdateien enthält.

Die CLI gibt absichtlich **keinen** `node_modules`-Pfad aus. Führen Sie immer zuerst `openclaw browser extension install` aus, um die Erweiterung in einen stabilen Speicherort unter Ihrem OpenClaw-State-Verzeichnis zu kopieren.

Wenn Sie dieses Installationsverzeichnis verschieben oder löschen, markiert Chrome die Erweiterung als defekt, bis Sie sie von einem gültigen Pfad erneut laden.

## Sicherheitsimplikationen (bitte lesen)

Dies ist leistungsfähig und riskant. Behandeln Sie es so, als würden Sie dem Modell „Hände an Ihrem Browser“ geben.

- Die Erweiterung verwendet die Debugger-API von Chrome (`chrome.debugger`). Wenn sie angekoppelt ist, kann das Modell:
  - in diesem Tab klicken/schreiben/navigieren
  - Seiteninhalte lesen
  - auf alles zugreifen, worauf die im Tab angemeldete Sitzung Zugriff hat
- **Dies ist nicht isoliert** wie das dedizierte, von OpenClaw verwaltete Profil.
  - Wenn Sie Ihr Alltagsprofil/-tab ankoppeln, gewähren Sie Zugriff auf diesen Kontostatus.

Empfehlungen:

- Bevorzugen Sie ein dediziertes Chrome-Profil (getrennt von Ihrem persönlichen Browsing) für die Nutzung des Erweiterungs-Relays.
- Halten Sie das Gateway und alle Node-Hosts auf Tailnet beschränkt; verlassen Sie sich auf Gateway-Authentifizierung + Node-Kopplung.
- Vermeiden Sie das Exponieren von Relay-Ports über das LAN (`0.0.0.0`) und vermeiden Sie Funnel (öffentlich).
- Das Relay blockiert Nicht-Erweiterungs-Ursprünge und erfordert ein internes Auth-Token für CDP-Clients.

Verwandt:

- Browser-Werkzeug-Überblick: [Browser](/tools/browser)
- Sicherheitsaudit: [Security](/gateway/security)
- Tailscale-Setup: [Tailscale](/gateway/tailscale)
