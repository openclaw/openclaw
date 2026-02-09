---
summary: "Node-Erkennung und Transporte (Bonjour, Tailscale, SSH) zum Auffinden des Gateways"
read_when:
  - Implementierung oder Änderung der Bonjour-Erkennung/-Ankündigung
  - Anpassung von Remote-Verbindungsmodi (direkt vs. SSH)
  - Entwurf Knotenerkennung + Paarung für entfernte Knoten
title: "Discovery und Transporte"
---

# Discovery & Transporte

OpenClaw hat zwei unterschiedliche Probleme, die auf den ersten Blick ähnlich aussehen:

1. **Operator-Fernsteuerung**: die macOS-Menüleisten-App steuert ein Gateway, das anderswo läuft.
2. **Node-Pairing**: iOS/Android (und zukünftige Nodes) finden ein Gateway und koppeln sich sicher.

Das Designziel ist, die gesamte Netzwerk-Erkennung/-Ankündigung im **Node Gateway** (`openclaw gateway`) zu halten und Clients (macOS-App, iOS) als Konsumenten zu behandeln.

## Begriffe

- **Gateway**: ein einzelner, lang laufender Gateway-Prozess, der den Zustand besitzt (Sitzungen, Pairing, Node-Registry) und Kanäle ausführt. Die meisten Setups verwenden einen pro Host; isolierte Multi-Gateway-Setups sind möglich.
- **Gateway WS (Control Plane)**: der WebSocket-Endpunkt auf `127.0.0.1:18789` standardmäßig; kann über LAN/Tailnet via `gateway.bind` gebunden werden.
- **Direkter WS-Transport**: ein LAN-/Tailnet-seitiger Gateway-WS-Endpunkt (ohne SSH).
- **SSH-Transport (Fallback)**: Fernsteuerung durch Weiterleitung von `127.0.0.1:18789` über SSH.
- **Legacy TCP Bridge (veraltet/entfernt)**: älterer Node-Transport (siehe [Bridge protocol](/gateway/bridge-protocol)); wird nicht mehr zur Erkennung angekündigt.

Protokolldetails:

- [Gateway protocol](/gateway/protocol)
- [Bridge protocol (legacy)](/gateway/bridge-protocol)

## Warum wir sowohl „direkt“ als auch SSH beibehalten

- **Direkter WS** bietet die beste UX im selben Netzwerk und innerhalb eines Tailnets:
  - Auto-Erkennung im LAN via Bonjour
  - Pairing-Tokens + ACLs werden vom Gateway verwaltet
  - kein Shell-Zugriff erforderlich; die Protokolloberfläche bleibt schlank und auditierbar
- **SSH** bleibt der universelle Fallback:
  - funktioniert überall dort, wo Sie SSH-Zugriff haben (auch über nicht zusammenhängende Netzwerke hinweg)
  - übersteht Multicast-/mDNS-Probleme
  - erfordert keine neuen eingehenden Ports außer SSH

## Discovery-Eingaben (wie Clients erfahren, wo das Gateway ist)

### 1. Bonjour / mDNS (nur LAN)

Bonjour ist Best-Effort und überquert keine Netzwerke. Es wird nur für „gleiches LAN“-Bequemlichkeit verwendet.

Zielrichtung:

- Das **Gateway** kündigt seinen WS-Endpunkt via Bonjour an.
- Clients durchsuchen und zeigen eine „Gateway auswählen“-Liste an und speichern anschließend den gewählten Endpunkt.

Fehlerbehebung und Beacon-Details: [Bonjour](/gateway/bonjour).

#### Service-Beacon-Details

- Service-Typen:
  - `_openclaw-gw._tcp` (Gateway-Transport-Beacon)
- TXT-Schlüssel (nicht geheim):
  - `role=gateway`
  - `lanHost=<hostname>.local`
  - `sshPort=22` (oder was auch immer angekündigt wird)
  - `gatewayPort=18789` (Gateway WS + HTTP)
  - `gatewayTls=1` (nur wenn TLS aktiviert ist)
  - `gatewayTlsSha256=<sha256>` (nur wenn TLS aktiviert ist und ein Fingerprint verfügbar ist)
  - `canvasPort=18793` (Standard-Canvas-Host-Port; bedient `/__openclaw__/canvas/`)
  - `cliPath=<path>` (optional; absoluter Pfad zu einem ausführbaren `openclaw`-Entrypoint oder Binary)
  - `tailnetDns=<magicdns>` (optional; Hinweis, automatisch erkannt, wenn Tailscale verfügbar ist)

Deaktivieren/Überschreiben:

- `OPENCLAW_DISABLE_BONJOUR=1` deaktiviert die Ankündigung.
- `gateway.bind` in `~/.openclaw/openclaw.json` steuert den Gateway-Bind-Modus.
- `OPENCLAW_SSH_PORT` überschreibt den in TXT angekündigten SSH-Port (Standard: 22).
- `OPENCLAW_TAILNET_DNS` veröffentlicht einen `tailnetDns`-Hinweis (MagicDNS).
- `OPENCLAW_CLI_PATH` überschreibt den angekündigten CLI-Pfad.

### 2. Tailnet (netzwerkübergreifend)

Für Setups im Stil London/Wien hilft Bonjour nicht. Das empfohlene „direkte“ Ziel ist:

- Tailscale-MagicDNS-Name (bevorzugt) oder eine stabile Tailnet-IP.

Wenn das Gateway erkennen kann, dass es unter Tailscale läuft, veröffentlicht es `tailnetDns` als optionalen Hinweis für Clients (einschließlich Weitbereichs-Beacons).

### 3. Manuelles / SSH-Ziel

Wenn es keine direkte Route gibt (oder direkt deaktiviert ist), können Clients jederzeit über SSH verbinden, indem sie den Loopback-Gateway-Port weiterleiten.

Siehe [Remote access](/gateway/remote).

## Transportauswahl (Client-Richtlinie)

Empfohlenes Client-Verhalten:

1. Wenn ein gekoppelter direkter Endpunkt konfiguriert und erreichbar ist, verwenden Sie ihn.
2. Andernfalls: Wenn Bonjour ein Gateway im LAN findet, bieten Sie eine Ein-Tipp-Option „Dieses Gateway verwenden“ an und speichern Sie es als direkten Endpunkt.
3. Andernfalls: Wenn eine Tailnet-DNS/IP konfiguriert ist, versuchen Sie direkt.
4. Andernfalls: Fallback auf SSH.

## Pairing + Auth (direkter Transport)

Das Gateway ist die maßgebliche Quelle für die Zulassung von Nodes/Clients.

- Pairing-Anfragen werden im Gateway erstellt/genehmigt/abgelehnt (siehe [Gateway pairing](/gateway/pairing)).
- Das Gateway erzwingt:
  - Authentifizierung (Token / Schlüsselpaar)
  - Scopes/ACLs (das Gateway ist kein roher Proxy zu jeder Methode)
  - Rate-Limits

## Verantwortlichkeiten nach Komponente

- **Gateway**: kündigt Discovery-Beacons an, trifft Pairing-Entscheidungen und hostet den WS-Endpunkt.
- **macOS-App**: hilft Ihnen bei der Auswahl eines Gateways, zeigt Pairing-Aufforderungen an und verwendet SSH nur als Fallback.
- **iOS/Android-Nodes**: durchsuchen Bonjour als Komfortfunktion und verbinden sich mit dem gekoppelten Gateway WS.
