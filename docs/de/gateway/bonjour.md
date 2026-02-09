---
summary: "Bonjour/mDNS-Erkennung + Debugging (Gateway-Beacons, Clients und häufige Fehlermodi)"
read_when:
  - Debugging von Bonjour-Erkennungsproblemen unter macOS/iOS
  - Ändern von mDNS-Servicetypen, TXT-Records oder der Discovery-UX
title: "Bonjour-Erkennung"
---

# Bonjour / mDNS-Erkennung

OpenClaw verwendet Bonjour (mDNS / DNS‑SD) als **reine LAN‑Komfortfunktion**, um
einen aktiven Gateway (WebSocket-Endpunkt) zu erkennen. Dies ist Best‑Effort und
ersetzt **nicht** SSH oder Tailnet‑basierte Konnektivität.

## Weitbereichs‑Bonjour (Unicast DNS‑SD) über Tailscale

Wenn sich Node und Gateway in unterschiedlichen Netzwerken befinden, überschreitet
multicast‑mDNS die Netzwerkgrenze nicht. Sie können die gleiche Discovery‑UX beibehalten,
indem Sie auf **Unicast DNS‑SD** („Wide‑Area Bonjour“) über Tailscale umstellen.

Hochwertige Schritte:

1. Betreiben Sie einen DNS‑Server auf dem Gateway‑Host (über das Tailnet erreichbar).
2. Veröffentlichen Sie DNS‑SD‑Records für `_openclaw-gw._tcp` unter einer dedizierten Zone
   (Beispiel: `openclaw.internal.`).
3. Konfigurieren Sie Tailscale **Split DNS**, sodass Ihre gewählte Domain für Clients
   (einschließlich iOS) über diesen DNS‑Server aufgelöst wird.

OpenClaw unterstützt jede Discovery‑Domain; `openclaw.internal.` ist nur ein Beispiel.
iOS/Android‑Nodes durchsuchen sowohl `local.` als auch Ihre konfigurierte
Weitbereichs‑Domain.

### Gateway‑Konfiguration (empfohlen)

```json5
{
  gateway: { bind: "tailnet" }, // tailnet-only (recommended)
  discovery: { wideArea: { enabled: true } }, // enables wide-area DNS-SD publishing
}
```

### Einmalige DNS‑Server‑Einrichtung (Gateway‑Host)

```bash
openclaw dns setup --apply
```

Dies installiert CoreDNS und konfiguriert es so, dass:

- auf Port 53 nur auf den Tailscale‑Interfaces des Gateways gelauscht wird
- Ihre gewählte Domain (Beispiel: `openclaw.internal.`) aus `~/.openclaw/dns/<domain>.db` bedient wird

Validieren Sie dies von einer mit dem Tailnet verbundenen Maschine:

```bash
dns-sd -B _openclaw-gw._tcp openclaw.internal.
dig @<TAILNET_IPV4> -p 53 _openclaw-gw._tcp.openclaw.internal PTR +short
```

### Tailscale‑DNS‑Einstellungen

In der Tailscale‑Admin‑Konsole:

- Fügen Sie einen Nameserver hinzu, der auf die Tailnet‑IP des Gateways zeigt (UDP/TCP 53).
- Fügen Sie Split DNS hinzu, sodass Ihre Discovery‑Domain diesen Nameserver verwendet.

Sobald Clients das Tailnet‑DNS akzeptieren, können iOS‑Nodes
`_openclaw-gw._tcp` in Ihrer Discovery‑Domain ohne Multicast durchsuchen.

### Sicherheit des Gateway‑Listeners (empfohlen)

Der Gateway‑WS‑Port (Standard `18789`) bindet standardmäßig an Loopback. Für
LAN-/Tailnet‑Zugriff binden Sie explizit und lassen die Authentifizierung aktiviert.

Für reine Tailnet‑Setups:

- Setzen Sie `gateway.bind: "tailnet"` in `~/.openclaw/openclaw.json`.
- Starten Sie den Gateway neu (oder starten Sie die macOS‑Menüleisten‑App neu).

## Was werbt

Nur der Gateway annonciert `_openclaw-gw._tcp`.

## Servicetypen

- `_openclaw-gw._tcp` — Gateway‑Transport‑Beacon (verwendet von macOS/iOS/Android‑Nodes).

## TXT‑Schlüssel (nicht‑geheime Hinweise)

Der Gateway annonciert kleine, nicht‑geheime Hinweise, um UI‑Abläufe zu vereinfachen:

- `role=gateway`
- `displayName=<friendly name>`
- `lanHost=<hostname>.local`
- `gatewayPort=<port>` (Gateway WS + HTTP)
- `gatewayTls=1` (nur wenn TLS aktiviert ist)
- `gatewayTlsSha256=<sha256>` (nur wenn TLS aktiviert ist und ein Fingerabdruck verfügbar ist)
- `canvasPort=<port>` (nur wenn der Canvas‑Host aktiviert ist; Standard `18793`)
- `sshPort=<port>` (Standard ist 22, wenn nicht überschrieben)
- `transport=gateway`
- `cliPath=<path>` (optional; absoluter Pfad zu einem ausführbaren `openclaw`‑Entrypoint)
- `tailnetDns=<magicdns>` (optionaler Hinweis, wenn Tailnet verfügbar ist)

## Debugging unter macOS

Nützliche integrierte Werkzeuge:

- Instanzen durchsuchen:

  ```bash
  dns-sd -B _openclaw-gw._tcp local.
  ```

- Eine Instanz auflösen (ersetzen Sie `<instance>`):

  ```bash
  dns-sd -L "<instance>" _openclaw-gw._tcp local.
  ```

Wenn das Durchsuchen funktioniert, das Auflösen jedoch fehlschlägt, liegt in der Regel
eine LAN‑Richtlinie oder ein mDNS‑Resolver‑Problem vor.

## Debugging in Gateway‑Logs

Der Gateway schreibt eine rotierende Logdatei (beim Start ausgegeben als
`gateway log file: ...`). Achten Sie auf `bonjour:`‑Zeilen, insbesondere:

- `bonjour: advertise failed ...`
- `bonjour: ... name conflict resolved` / `hostname conflict resolved`
- `bonjour: watchdog detected non-announced service ...`

## Debugging auf dem iOS‑Node

Der iOS‑Node verwendet `NWBrowser`, um `_openclaw-gw._tcp` zu erkennen.

So erfassen Sie Logs:

- Einstellungen → Gateway → Erweitert → **Discovery‑Debug‑Logs**
- Einstellungen → Gateway → Erweitert → **Discovery‑Logs** → reproduzieren → **Kopieren**

Das Log enthält Zustandsübergänge des Browsers und Änderungen der Ergebnismenge.

## Häufige Fehlermodi

- **Bonjour überschreitet keine Netzwerke**: Verwenden Sie Tailnet oder SSH.
- **Multicast blockiert**: Einige WLAN‑Netze deaktivieren mDNS.
- **Sleep / Interface‑Wechsel**: macOS kann mDNS‑Ergebnisse vorübergehend verwerfen; erneut versuchen.
- **Durchsuchen funktioniert, Auflösen schlägt fehl**: Halten Sie Rechnernamen einfach
  (vermeiden Sie Emojis oder Satzzeichen) und starten Sie anschließend den Gateway neu. Der Service‑Instanzname leitet sich vom Hostnamen ab; zu komplexe Namen können einige
  Resolver verwirren.

## Escaped Instanznamen (`\032`)

Bonjour/DNS‑SD escaped häufig Bytes in Service‑Instanznamen als dezimale
`\DDD`‑Sequenzen (z. B. werden Leerzeichen zu `\032`).

- Dies ist auf Protokollebene normal.
- UIs sollten zur Anzeige dekodieren (iOS verwendet `BonjourEscapes.decode`).

## Deaktivierung / Konfiguration

- `OPENCLAW_DISABLE_BONJOUR=1` deaktiviert die Ankündigung (Legacy: `OPENCLAW_DISABLE_BONJOUR`).
- `gateway.bind` in `~/.openclaw/openclaw.json` steuert den Bind‑Modus des Gateways.
- `OPENCLAW_SSH_PORT` überschreibt den in TXT annoncierten SSH‑Port (Legacy: `OPENCLAW_SSH_PORT`).
- `OPENCLAW_TAILNET_DNS` veröffentlicht einen MagicDNS‑Hinweis in TXT (Legacy: `OPENCLAW_TAILNET_DNS`).
- `OPENCLAW_CLI_PATH` überschreibt den annoncierten CLI‑Pfad (Legacy: `OPENCLAW_CLI_PATH`).

## Verwandte Dokumente

- Discovery‑Richtlinie und Transportauswahl: [Discovery](/gateway/discovery)
- Node‑Pairing + Genehmigungen: [Gateway pairing](/gateway/pairing)
