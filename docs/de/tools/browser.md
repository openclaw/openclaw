---
summary: "„Integrierter Browsersteuerungsdienst + Aktionsbefehle“"
read_when:
  - Hinzufügen agentengesteuerter Browserautomatisierung
  - Debuggen, warum OpenClaw mit Ihrem eigenen Chrome interferiert
  - Implementieren von Browsereinstellungen und -lebenszyklus in der macOS-App
title: "„Browser (OpenClaw-verwaltet)“"
---

# Browser (openclaw-verwaltet)

OpenClaw kann ein **dediziertes Chrome/Brave/Edge/Chromium-Profil** ausführen, das vom Agenten gesteuert wird.
Es ist von Ihrem persönlichen Browser isoliert und wird über einen kleinen lokalen
Steuerungsdienst innerhalb des Gateway (nur Loopback) verwaltet.

Einsteigeransicht:

- Betrachten Sie es als einen **separaten, agentenexklusiven Browser**.
- Das Profil `openclaw` greift **nicht** auf Ihr persönliches Browserprofil zu.
- Der Agent kann **Tabs öffnen, Seiten lesen, klicken und tippen** – in einer sicheren Spur.
- Das Standardprofil `chrome` verwendet den **systemweiten Standard-Chromium-Browser** über das
  Extension-Relay; wechseln Sie zu `openclaw` für den isolierten, verwalteten Browser.

## Was Sie erhalten

- Ein separates Browserprofil namens **openclaw** (standardmäßig mit orangefarbenem Akzent).
- Deterministische Tab-Steuerung (auflisten/öffnen/fokussieren/schließen).
- Agentenaktionen (klicken/tippen/ziehen/auswählen), Snapshots, Screenshots, PDFs.
- Optionale Unterstützung mehrerer Profile (`openclaw`, `work`, `remote`, ...).

Dieser Browser ist **nicht** Ihr täglicher Begleiter. Er ist eine sichere, isolierte Oberfläche für
Agentenautomatisierung und Verifikation.

## Schnellstart

```bash
openclaw browser --browser-profile openclaw status
openclaw browser --browser-profile openclaw start
openclaw browser --browser-profile openclaw open https://example.com
openclaw browser --browser-profile openclaw snapshot
```

Wenn Sie „Browser disabled“ erhalten, aktivieren Sie ihn in der Konfiguration (siehe unten) und starten Sie das
Gateway neu.

## Profile: `openclaw` vs `chrome`

- `openclaw`: verwalteter, isolierter Browser (keine Erweiterung erforderlich).
- `chrome`: Extension-Relay zu Ihrem **Systembrowser** (erfordert, dass die OpenClaw-
  Erweiterung an einen Tab angeheftet ist).

Setzen Sie `browser.defaultProfile: "openclaw"`, wenn Sie den verwalteten Modus standardmäßig verwenden möchten.

## Konfiguration

Browsereinstellungen befinden sich in `~/.openclaw/openclaw.json`.

```json5
{
  browser: {
    enabled: true, // default: true
    // cdpUrl: "http://127.0.0.1:18792", // legacy single-profile override
    remoteCdpTimeoutMs: 1500, // remote CDP HTTP timeout (ms)
    remoteCdpHandshakeTimeoutMs: 3000, // remote CDP WebSocket handshake timeout (ms)
    defaultProfile: "chrome",
    color: "#FF4500",
    headless: false,
    noSandbox: false,
    attachOnly: false,
    executablePath: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    profiles: {
      openclaw: { cdpPort: 18800, color: "#FF4500" },
      work: { cdpPort: 18801, color: "#0066CC" },
      remote: { cdpUrl: "http://10.0.0.42:9222", color: "#00AA00" },
    },
  },
}
```

Hinweise:

- Der Browsersteuerungsdienst bindet an Loopback auf einem Port, der von `gateway.port`
  abgeleitet ist (Standard: `18791`, also Gateway + 2). Das Relay verwendet den nächsten Port (`18792`).
- Wenn Sie den Gateway-Port überschreiben (`gateway.port` oder `OPENCLAW_GATEWAY_PORT`),
  verschieben sich die abgeleiteten Browser-Ports, um in derselben „Familie“ zu bleiben.
- `cdpUrl` verwendet standardmäßig den Relay-Port, wenn er nicht gesetzt ist.
- `remoteCdpTimeoutMs` gilt für Remote-CDP-Erreichbarkeitsprüfungen (nicht Loopback).
- `remoteCdpHandshakeTimeoutMs` gilt für Remote-CDP-WebSocket-Erreichbarkeitsprüfungen.
- `attachOnly: true` bedeutet „nie einen lokalen Browser starten; nur anhängen, wenn er bereits läuft“.
- `color` + profilbezogenes `color` färben die Browser-UI, damit Sie sehen, welches Profil aktiv ist.
- Standardprofil ist `chrome` (Extension-Relay). Verwenden Sie `defaultProfile: "openclaw"` für den verwalteten Browser.
- Auto-Erkennungsreihenfolge: systemweiter Standardbrowser, falls Chromium-basiert; andernfalls Chrome → Brave → Edge → Chromium → Chrome Canary.
- Lokale `openclaw`-Profile weisen `cdpPort`/`cdpUrl` automatisch zu — setzen Sie diese nur für Remote-CDP.

## Brave (oder einen anderen Chromium-basierten Browser) verwenden

Wenn Ihr **systemweiter Standardbrowser** Chromium-basiert ist (Chrome/Brave/Edge/etc.),
verwendet OpenClaw ihn automatisch. Setzen Sie `browser.executablePath`, um die
Auto-Erkennung zu überschreiben:

CLI-Beispiel:

```bash
openclaw config set browser.executablePath "/usr/bin/google-chrome"
```

```json5
// macOS
{
  browser: {
    executablePath: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
  }
}

// Windows
{
  browser: {
    executablePath: "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe"
  }
}

// Linux
{
  browser: {
    executablePath: "/usr/bin/brave-browser"
  }
}
```

## Lokale vs. Remote-Steuerung

- **Lokale Steuerung (Standard):** Das Gateway startet den Loopback-Steuerungsdienst und kann einen lokalen Browser starten.
- **Remote-Steuerung (Node-Host):** Führen Sie einen Node-Host auf der Maschine aus, auf der sich der Browser befindet; das Gateway leitet Browseraktionen dorthin weiter.
- **Remote CDP:** Setzen Sie `browser.profiles.<name>.cdpUrl` (oder `browser.cdpUrl`), um
  sich an einen entfernten Chromium-basierten Browser anzuhängen. In diesem Fall startet OpenClaw keinen lokalen Browser.

Remote-CDP-URLs können Authentifizierung enthalten:

- Query-Token (z. B. `https://provider.example?token=<token>`)
- HTTP-Basic-Auth (z. B. `https://user:pass@provider.example`)

OpenClaw bewahrt die Authentifizierung bei Aufrufen von `/json/*`-Endpunkten und bei der Verbindung
zum CDP-WebSocket. Bevorzugen Sie Umgebungsvariablen oder Secrets-Manager für
Token, anstatt sie in Konfigurationsdateien zu committen.

## Node-Browser-Proxy (Zero-Config-Standard)

Wenn Sie einen **Node-Host** auf der Maschine ausführen, auf der sich Ihr Browser befindet, kann OpenClaw
Browser-Werkzeugaufrufe automatisch zu diesem Node routen, ohne zusätzliche Browserkonfiguration.
Dies ist der Standardpfad für Remote-Gateways.

Hinweise:

- Der Node-Host stellt seinen lokalen Browsersteuerungsserver über einen **Proxy-Befehl** bereit.
- Profile stammen aus der eigenen `browser.profiles`-Konfiguration des Nodes (wie lokal).
- Deaktivieren, wenn Sie dies nicht möchten:
  - Auf dem Node: `nodeHost.browserProxy.enabled=false`
  - Auf dem Gateway: `gateway.nodes.browser.mode="off"`

## Browserless (gehostetes Remote-CDP)

[Browserless](https://browserless.io) ist ein gehosteter Chromium-Dienst, der
CDP-Endpunkte über HTTPS bereitstellt. Sie können ein OpenClaw-Browserprofil auf einen
Browserless-Regionsendpunkt ausrichten und sich mit Ihrem API-Schlüssel authentifizieren.

Beispiel:

```json5
{
  browser: {
    enabled: true,
    defaultProfile: "browserless",
    remoteCdpTimeoutMs: 2000,
    remoteCdpHandshakeTimeoutMs: 4000,
    profiles: {
      browserless: {
        cdpUrl: "https://production-sfo.browserless.io?token=<BROWSERLESS_API_KEY>",
        color: "#00AA00",
      },
    },
  },
}
```

Hinweise:

- Ersetzen Sie `<BROWSERLESS_API_KEY>` durch Ihr echtes Browserless-Token.
- Wählen Sie den Regionsendpunkt, der zu Ihrem Browserless-Konto passt (siehe deren Dokumentation).

## Sicherheit

Schlüsselideen:

- Die Browsersteuerung ist ausschließlich Loopback; der Zugriff erfolgt über die Authentifizierung des Gateway oder die Node-Paarung.
- Halten Sie das Gateway und alle Node-Hosts in einem privaten Netzwerk (Tailscale); vermeiden Sie öffentliche Exposition.
- Behandeln Sie Remote-CDP-URLs/Token als Geheimnisse; bevorzugen Sie Umgebungsvariablen oder einen Secrets-Manager.

Remote-CDP-Tipps:

- Bevorzugen Sie HTTPS-Endpunkte und kurzlebige Token, wo möglich.
- Vermeiden Sie das direkte Einbetten langlebiger Token in Konfigurationsdateien.

## Profile (Multi-Browser)

OpenClaw unterstützt mehrere benannte Profile (Routing-Konfigurationen). Profile können sein:

- **openclaw-managed**: eine dedizierte Chromium-basierte Browserinstanz mit eigenem User-Data-Verzeichnis + CDP-Port
- **remote**: eine explizite CDP-URL (Chromium-basierter Browser läuft anderswo)
- **extension relay**: Ihre bestehenden Chrome-Tabs über das lokale Relay + Chrome-Erweiterung

Standards:

- Das Profil `openclaw` wird automatisch erstellt, falls es fehlt.
- Das Profil `chrome` ist integriert für das Chrome-Extension-Relay (zeigt standardmäßig auf `http://127.0.0.1:18792`).
- Lokale CDP-Ports werden standardmäßig aus **18800–18899** vergeben.
- Das Löschen eines Profils verschiebt dessen lokales Datenverzeichnis in den Papierkorb.

Alle Steuerungsendpunkte akzeptieren `?profile=<name>`; die CLI verwendet `--browser-profile`.

## Chrome-Extension-Relay (Ihren bestehenden Chrome verwenden)

OpenClaw kann auch **Ihre bestehenden Chrome-Tabs steuern** (keine separate „openclaw“-Chrome-Instanz) über ein lokales CDP-Relay + eine Chrome-Erweiterung.

Vollständige Anleitung: [Chrome extension](/tools/chrome-extension)

Ablauf:

- Das Gateway läuft lokal (gleiche Maschine) oder ein Node-Host läuft auf der Browser-Maschine.
- Ein lokaler **Relay-Server** lauscht auf einem Loopback-`cdpUrl` (Standard: `http://127.0.0.1:18792`).
- Sie klicken auf das **OpenClaw Browser Relay**-Erweiterungssymbol in einem Tab, um anzuhängen (keine automatische Anheftung).
- Der Agent steuert diesen Tab über das normale `browser`-Werkzeug, indem das richtige Profil ausgewählt wird.

Wenn das Gateway anderswo läuft, führen Sie einen Node-Host auf der Browser-Maschine aus, damit das Gateway Browseraktionen weiterleiten kann.

### Sandboxed-Sitzungen

Wenn die Agentensitzung sandboxed ist, kann das `browser`-Werkzeug standardmäßig auf `target="sandbox"` (Sandbox-Browser) zeigen.
Die Übernahme des Chrome-Extension-Relays erfordert Host-Browsersteuerung, daher entweder:

- die Sitzung unsandboxed ausführen oder
- `agents.defaults.sandbox.browser.allowHostControl: true` setzen und `target="host"` beim Aufruf des Werkzeugs verwenden.

### Einrichtung

1. Erweiterung laden (Dev/Unpacked):

```bash
openclaw browser extension install
```

- Chrome → `chrome://extensions` → „Developer mode“ aktivieren
- „Load unpacked“ → das von `openclaw browser extension path` ausgegebene Verzeichnis auswählen
- Erweiterung anheften und dann im gewünschten Tab anklicken (Badge zeigt `ON`).

2. Verwenden:

- CLI: `openclaw browser --browser-profile chrome tabs`
- Agentenwerkzeug: `browser` mit `profile="chrome"`

Optional: Wenn Sie einen anderen Namen oder Relay-Port möchten, erstellen Sie ein eigenes Profil:

```bash
openclaw browser create-profile \
  --name my-chrome \
  --driver extension \
  --cdp-url http://127.0.0.1:18792 \
  --color "#00AA00"
```

Hinweise:

- Dieser Modus stützt sich für die meisten Operationen (Screenshots/Snapshots/Aktionen) auf Playwright-on-CDP.
- Trennen durch erneutes Klicken auf das Erweiterungssymbol.

## Isolationsgarantien

- **Dediziertes User-Data-Verzeichnis**: greift niemals auf Ihr persönliches Browserprofil zu.
- **Dedizierte Ports**: vermeidet `9222`, um Kollisionen mit Entwicklungs-Workflows zu verhindern.
- **Deterministische Tab-Steuerung**: Zielauswahl nach `targetId`, nicht nach „letztem Tab“.

## Browserauswahl

Beim lokalen Start wählt OpenClaw den zuerst verfügbaren:

1. Chrome
2. Brave
3. Edge
4. Chromium
5. Chrome Canary

Sie können dies mit `browser.executablePath` überschreiben.

Plattformen:

- macOS: prüft `/Applications` und `~/Applications`.
- Linux: sucht nach `google-chrome`, `brave`, `microsoft-edge`, `chromium` usw.
- Windows: prüft gängige Installationspfade.

## Control API (optional)

Nur für lokale Integrationen stellt das Gateway eine kleine Loopback-HTTP-API bereit:

- Status/Start/Stopp: `GET /`, `POST /start`, `POST /stop`
- Tabs: `GET /tabs`, `POST /tabs/open`, `POST /tabs/focus`, `DELETE /tabs/:targetId`
- Snapshot/Screenshot: `GET /snapshot`, `POST /screenshot`
- Aktionen: `POST /navigate`, `POST /act`
- Hooks: `POST /hooks/file-chooser`, `POST /hooks/dialog`
- Downloads: `POST /download`, `POST /wait/download`
- Debugging: `GET /console`, `POST /pdf`
- Debugging: `GET /errors`, `GET /requests`, `POST /trace/start`, `POST /trace/stop`, `POST /highlight`
- Netzwerk: `POST /response/body`
- Zustand: `GET /cookies`, `POST /cookies/set`, `POST /cookies/clear`
- Zustand: `GET /storage/:kind`, `POST /storage/:kind/set`, `POST /storage/:kind/clear`
- Einstellungen: `POST /set/offline`, `POST /set/headers`, `POST /set/credentials`, `POST /set/geolocation`, `POST /set/media`, `POST /set/timezone`, `POST /set/locale`, `POST /set/device`

Alle Endpunkte akzeptieren `?profile=<name>`.

### Playwright-Anforderung

Einige Funktionen (Navigation/Aktionen/AI-Snapshot/Rollen-Snapshot, Element-Screenshots, PDF) erfordern
Playwright. Ist Playwright nicht installiert, geben diese Endpunkte einen klaren 501-
Fehler zurück. ARIA-Snapshots und einfache Screenshots funktionieren weiterhin für openclaw-verwaltetes Chrome.
Für den Chrome-Extension-Relay-Treiber erfordern ARIA-Snapshots und Screenshots Playwright.

Wenn Sie `Playwright is not available in this gateway build` sehen, installieren Sie das vollständige
Playwright-Paket (nicht `playwright-core`) und starten Sie das Gateway neu oder installieren Sie
OpenClaw mit Browserunterstützung neu.

#### Docker-Playwright-Installation

Wenn Ihr Gateway in Docker läuft, vermeiden Sie `npx playwright` (npm-Override-Konflikte).
Verwenden Sie stattdessen die gebündelte CLI:

```bash
docker compose run --rm openclaw-cli \
  node /app/node_modules/playwright-core/cli.js install chromium
```

Um Browser-Downloads zu persistieren, setzen Sie `PLAYWRIGHT_BROWSERS_PATH` (z. B. `/home/node/.cache/ms-playwright`) und stellen Sie sicher, dass `/home/node` über
`OPENCLAW_HOME_VOLUME` oder ein Bind-Mount persistiert wird. Siehe [Docker](/install/docker).

## Funktionsweise (intern)

Ablauf auf hoher Ebene:

- Ein kleiner **Steuerungsserver** akzeptiert HTTP-Anfragen.
- Er verbindet sich mit Chromium-basierten Browsern (Chrome/Brave/Edge/Chromium) über **CDP**.
- Für erweiterte Aktionen (klicken/tippen/snapshot/PDF) nutzt er **Playwright** auf CDP.
- Fehlt Playwright, stehen nur Nicht-Playwright-Operationen zur Verfügung.

Dieses Design hält den Agenten auf einer stabilen, deterministischen Schnittstelle, während Sie
lokale/remote Browser und Profile austauschen können.

## CLI-Schnellreferenz

Alle Befehle akzeptieren `--browser-profile <name>`, um ein bestimmtes Profil anzusprechen.
Alle Befehle akzeptieren außerdem `--json` für maschinenlesbare Ausgabe (stabile Payloads).

Grundlagen:

- `openclaw browser status`
- `openclaw browser start`
- `openclaw browser stop`
- `openclaw browser tabs`
- `openclaw browser tab`
- `openclaw browser tab new`
- `openclaw browser tab select 2`
- `openclaw browser tab close 2`
- `openclaw browser open https://example.com`
- `openclaw browser focus abcd1234`
- `openclaw browser close abcd1234`

Inspektion:

- `openclaw browser screenshot`
- `openclaw browser screenshot --full-page`
- `openclaw browser screenshot --ref 12`
- `openclaw browser screenshot --ref e12`
- `openclaw browser snapshot`
- `openclaw browser snapshot --format aria --limit 200`
- `openclaw browser snapshot --interactive --compact --depth 6`
- `openclaw browser snapshot --efficient`
- `openclaw browser snapshot --labels`
- `openclaw browser snapshot --selector "#main" --interactive`
- `openclaw browser snapshot --frame "iframe#main" --interactive`
- `openclaw browser console --level error`
- `openclaw browser errors --clear`
- `openclaw browser requests --filter api --clear`
- `openclaw browser pdf`
- `openclaw browser responsebody "**/api" --max-chars 5000`

Aktionen:

- `openclaw browser navigate https://example.com`
- `openclaw browser resize 1280 720`
- `openclaw browser click 12 --double`
- `openclaw browser click e12 --double`
- `openclaw browser type 23 "hello" --submit`
- `openclaw browser press Enter`
- `openclaw browser hover 44`
- `openclaw browser scrollintoview e12`
- `openclaw browser drag 10 11`
- `openclaw browser select 9 OptionA OptionB`
- `openclaw browser download e12 /tmp/report.pdf`
- `openclaw browser waitfordownload /tmp/report.pdf`
- `openclaw browser upload /tmp/file.pdf`
- `openclaw browser fill --fields '[{"ref":"1","type":"text","value":"Ada"}]'`
- `openclaw browser dialog --accept`
- `openclaw browser wait --text "Done"`
- `openclaw browser wait "#main" --url "**/dash" --load networkidle --fn "window.ready===true"`
- `openclaw browser evaluate --fn '(el) => el.textContent' --ref 7`
- `openclaw browser highlight e12`
- `openclaw browser trace start`
- `openclaw browser trace stop`

Zustand:

- `openclaw browser cookies`
- `openclaw browser cookies set session abc123 --url "https://example.com"`
- `openclaw browser cookies clear`
- `openclaw browser storage local get`
- `openclaw browser storage local set theme dark`
- `openclaw browser storage session clear`
- `openclaw browser set offline on`
- `openclaw browser set headers --json '{"X-Debug":"1"}'`
- `openclaw browser set credentials user pass`
- `openclaw browser set credentials --clear`
- `openclaw browser set geo 37.7749 -122.4194 --origin "https://example.com"`
- `openclaw browser set geo --clear`
- `openclaw browser set media dark`
- `openclaw browser set timezone America/New_York`
- `openclaw browser set locale en-US`
- `openclaw browser set device "iPhone 14"`

Hinweise:

- `upload` und `dialog` sind **Arming**-Aufrufe; führen Sie sie vor dem Klick/Tastendruck aus,
  der den Auswahldialog auslöst.
- `upload` kann Dateieingaben auch direkt über `--input-ref` oder `--element` setzen.
- `snapshot`:
  - `--format ai` (Standard, wenn Playwright installiert ist): gibt einen AI-Snapshot mit numerischen Referenzen (`aria-ref="<n>"`) zurück.
  - `--format aria`: gibt den Accessibility-Baum zurück (keine Referenzen; nur Inspektion).
  - `--efficient` (oder `--mode efficient`): kompaktes Rollen-Snapshot-Preset (interaktiv + kompakt + Tiefe + niedrigere maxChars).
  - Konfigurationsstandard (nur Werkzeug/CLI): Setzen Sie `browser.snapshotDefaults.mode: "efficient"`, um effiziente Snapshots zu verwenden, wenn der Aufrufer keinen Modus übergibt (siehe [Gateway-Konfiguration](/gateway/configuration#browser-openclaw-managed-browser)).
  - Optionen für Rollen-Snapshots (`--interactive`, `--compact`, `--depth`, `--selector`) erzwingen ein rollenbasiertes Snapshot mit Referenzen wie `ref=e12`.
  - `--frame "<iframe selector>"` begrenzt Rollen-Snapshots auf ein iframe (in Kombination mit Rollen-Referenzen wie `e12`).
  - `--interactive` gibt eine flache, leicht auswählbare Liste interaktiver Elemente aus (am besten zum Steuern von Aktionen).
  - `--labels` fügt einen Screenshot nur des Viewports mit überlagerten Referenzlabels hinzu (gibt `MEDIA:<path>` aus).
- `click`/`type`/etc. erfordern eine `ref` aus `snapshot` (entweder numerische `12` oder Rollen-Referenz `e12`).
  CSS-Selektoren werden für Aktionen bewusst nicht unterstützt.

## Snapshots und Referenzen

OpenClaw unterstützt zwei „Snapshot“-Stile:

- **AI-Snapshot (numerische Referenzen)**: `openclaw browser snapshot` (Standard; `--format ai`)
  - Ausgabe: ein Text-Snapshot mit numerischen Referenzen.
  - Aktionen: `openclaw browser click 12`, `openclaw browser type 23 "hello"`.
  - Intern wird die Referenz über Playwrights `aria-ref` aufgelöst.

- **Rollen-Snapshot (Rollen-Referenzen wie `e12`)**: `openclaw browser snapshot --interactive` (oder `--compact`, `--depth`, `--selector`, `--frame`)
  - Ausgabe: eine rollenbasierte Liste/Baum mit `[ref=e12]` (und optional `[nth=1]`).
  - Aktionen: `openclaw browser click e12`, `openclaw browser highlight e12`.
  - Intern wird die Referenz über `getByRole(...)` aufgelöst (zzgl. `nth()` bei Duplikaten).
  - Fügen Sie `--labels` hinzu, um einen Viewport-Screenshot mit überlagerten `e12`-Labels einzuschließen.

Referenzverhalten:

- Referenzen sind **nicht stabil über Navigationswechsel hinweg**; wenn etwas fehlschlägt, führen Sie `snapshot` erneut aus und verwenden Sie eine frische Referenz.
- Wenn der Rollen-Snapshot mit `--frame` erstellt wurde, sind Rollen-Referenzen bis zum nächsten Rollen-Snapshot auf dieses iframe beschränkt.

## Wait-Power-ups

Sie können auf mehr als nur Zeit/Text warten:

- Auf URL warten (Globs werden von Playwright unterstützt):
  - `openclaw browser wait --url "**/dash"`
- Auf Ladezustand warten:
  - `openclaw browser wait --load networkidle`
- Auf ein JS-Prädikat warten:
  - `openclaw browser wait --fn "window.ready===true"`
- Auf einen Selektor warten, bis er sichtbar wird:
  - `openclaw browser wait "#main"`

Diese können kombiniert werden:

```bash
openclaw browser wait "#main" \
  --url "**/dash" \
  --load networkidle \
  --fn "window.ready===true" \
  --timeout-ms 15000
```

## Debug-Workflows

Wenn eine Aktion fehlschlägt (z. B. „not visible“, „strict mode violation“, „covered“):

1. `openclaw browser snapshot --interactive`
2. Verwenden Sie `click <ref>` / `type <ref>` (bevorzugen Sie Rollen-Referenzen im interaktiven Modus)
3. Falls es weiterhin fehlschlägt: `openclaw browser highlight <ref>`, um zu sehen, worauf Playwright zielt
4. Wenn sich die Seite merkwürdig verhält:
   - `openclaw browser errors --clear`
   - `openclaw browser requests --filter api --clear`
5. Für tiefgehendes Debugging: einen Trace aufzeichnen:
   - `openclaw browser trace start`
   - das Problem reproduzieren
   - `openclaw browser trace stop` (gibt `TRACE:<path>` aus)

## JSON-Ausgabe

`--json` ist für Skripting und strukturierte Werkzeuge gedacht.

Beispiele:

```bash
openclaw browser status --json
openclaw browser snapshot --interactive --json
openclaw browser requests --filter api --json
openclaw browser cookies --json
```

Rollen-Snapshots in JSON enthalten `refs` sowie einen kleinen `stats`-Block (Zeilen/Zeichen/Referenzen/Interaktiv), damit Werkzeuge über Payload-Größe und -Dichte entscheiden können.

## Zustands- und Umgebungsregler

Diese sind nützlich für Workflows nach dem Muster „die Seite soll sich wie X verhalten“:

- Cookies: `cookies`, `cookies set`, `cookies clear`
- Storage: `storage local|session get|set|clear`
- Offline: `set offline on|off`
- Header: `set headers --json '{"X-Debug":"1"}'` (oder `--clear`)
- HTTP-Basic-Auth: `set credentials user pass` (oder `--clear`)
- Geolokalisierung: `set geo <lat> <lon> --origin "https://example.com"` (oder `--clear`)
- Medien: `set media dark|light|no-preference|none`
- Zeitzone / Locale: `set timezone ...`, `set locale ...`
- Gerät / Viewport:
  - `set device "iPhone 14"` (Playwright-Gerätevoreinstellungen)
  - `set viewport 1280 720`

## Sicherheit & Datenschutz

- Das openclaw-Browserprofil kann eingeloggte Sitzungen enthalten; behandeln Sie es als sensibel.
- `browser act kind=evaluate` / `openclaw browser evaluate` und `wait --fn`
  führen beliebiges JavaScript im Seitenkontext aus. Prompt-Injection kann dies steuern. Deaktivieren Sie es mit `browser.evaluateEnabled=false`, wenn Sie es nicht benötigen.
- Hinweise zu Logins und Anti-Bot-Themen (X/Twitter usw.) finden Sie unter [Browser login + X/Twitter posting](/tools/browser-login).
- Halten Sie Gateway/Node-Host privat (Loopback oder nur Tailnet).
- Remote-CDP-Endpunkte sind mächtig; tunneln und schützen Sie sie.

## Fehlerbehebung

Für Linux-spezifische Probleme (insbesondere Snap-Chromium) siehe
[Browser troubleshooting](/tools/browser-linux-troubleshooting).

## Agentenwerkzeuge + Funktionsweise der Steuerung

Der Agent erhält **ein Werkzeug** für Browserautomatisierung:

- `browser` — Status/Start/Stopp/Tabs/Öffnen/Fokussieren/Schließen/Snapshot/Screenshot/Navigation/Aktion

Wie es kartiert:

- `browser snapshot` gibt eine stabile UI-Struktur zurück (AI oder ARIA).
- `browser act` verwendet die Snapshot-`ref`-IDs zum Klicken/Tippen/Ziehen/Auswählen.
- `browser screenshot` erfasst Pixel (ganze Seite oder Element).
- `browser` akzeptiert:
  - `profile`, um ein benanntes Browserprofil auszuwählen (openclaw, chrome oder Remote-CDP).
  - `target` (`sandbox` | `host` | `node`), um auszuwählen, wo der Browser läuft.
  - In sandboxed Sitzungen erfordert `target: "host"` `agents.defaults.sandbox.browser.allowHostControl=true`.
  - Wenn `target` weggelassen wird: sandboxed Sitzungen verwenden standardmäßig `sandbox`, nicht-sandboxed Sitzungen standardmäßig `host`.
  - Wenn ein browserfähiger Node verbunden ist, kann das Werkzeug automatisch dorthin routen, sofern Sie `target="host"` oder `target="node"` nicht anheften.

Dies hält den Agenten deterministisch und vermeidet fragile Selektoren.
