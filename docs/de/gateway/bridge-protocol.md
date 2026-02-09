---
summary: "Bridge-Protokoll (Legacy-Nodes): TCP JSONL, Pairing, Scoped RPC"
read_when:
  - Erstellen oder Debuggen von Node-Clients (iOS/Android/macOS Node-Modus)
  - Untersuchung von Pairing- oder Bridge-Authentifizierungsfehlern
  - Audit der vom Gateway exponierten Node-Oberfläche
title: "Bridge-Protokoll"
---

# Bridge-Protokoll (Legacy-Node-Transport)

Das Bridge-Protokoll ist ein **Legacy**-Node-Transport (TCP JSONL). Neue Node-Clients
sollten stattdessen das einheitliche Gateway-WebSocket-Protokoll verwenden.

Wenn Sie einen Operator oder Node-Client entwickeln, verwenden Sie das
[Gateway-Protokoll](/gateway/protocol).

**Hinweis:** Aktuelle OpenClaw-Builds liefern den TCP-Bridge-Listener nicht mehr aus; dieses Dokument dient der historischen Referenz.
Legacy-`bridge.*`-Konfigurationsschlüssel sind nicht mehr Teil des Konfigurationsschemas.

## Warum es beides gibt

- **Sicherheitsgrenze**: Die Bridge stellt eine kleine Allowlist bereit statt der
  vollständigen Gateway-API-Oberfläche.
- **Pairing + Node-Identität**: Die Aufnahme von Nodes wird vom Gateway gesteuert und ist
  an ein Node-spezifisches Token gebunden.
- **Discovery-UX**: Nodes können Gateways per Bonjour im LAN entdecken oder sich
  direkt über ein Tailnet verbinden.
- **Loopback-WS**: Die vollständige WS-Kontroll­ebene bleibt lokal, sofern sie nicht
  per SSH getunnelt wird.

## Transport

- TCP, ein JSON-Objekt pro Zeile (JSONL).
- Optionales TLS (wenn `bridge.tls.enabled` true ist).
- Der Legacy-Standard-Listener-Port war `18790` (aktuelle Builds starten keine TCP-Bridge).

Wenn TLS aktiviert ist, enthalten Discovery-TXT-Records `bridgeTls=1` plus
`bridgeTlsSha256`, damit Nodes das Zertifikat pinnen können.

## Handshake + Pairing

1. Der Client sendet `hello` mit Node-Metadaten + Token (falls bereits gepairt).
2. Falls nicht gepairt, antwortet das Gateway mit `error` (`NOT_PAIRED`/`UNAUTHORIZED`).
3. Der Client sendet `pair-request`.
4. Das Gateway wartet auf die Freigabe und sendet dann `pair-ok` und `hello-ok`.

`hello-ok` liefert `serverName` zurück und kann `canvasHostUrl` enthalten.

## Frames

Client → Gateway:

- `req` / `res`: Scoped Gateway-RPC (Chat, Sitzungen, Konfiguration, Health, Voicewake, skills.bins)
- `event`: Node-Signale (Sprachtranskript, Agent-Anfrage, Chat-Abonnement, Exec-Lifecycle)

Gateway → Client:

- `invoke` / `invoke-res`: Node-Befehle (`canvas.*`, `camera.*`, `screen.record`,
  `location.get`, `sms.send`)
- `event`: Chat-Updates für abonnierte Sitzungen
- `ping` / `pong`: Keepalive

Die Durchsetzung der Legacy-Allowlist befand sich in `src/gateway/server-bridge.ts` (entfernt).

## Exec-Lifecycle-Ereignisse

Nodes können `exec.finished`- oder `exec.denied`-Ereignisse senden, um system.run-Aktivitäten offenzulegen.
Diese werden im Gateway auf Systemereignisse abgebildet. (Legacy-Nodes können weiterhin `exec.started` senden.)

Payload-Felder (alle optional, sofern nicht anders angegeben):

- `sessionKey` (erforderlich): Agent-Sitzung, die das Systemereignis empfangen soll.
- `runId`: eindeutige Exec-ID zur Gruppierung.
- `command`: roher oder formatierter Befehlsstring.
- `exitCode`, `timedOut`, `success`, `output`: Abschlussdetails (nur bei „finished“).
- `reason`: Ablehnungsgrund (nur bei „denied“).

## Tailnet-Nutzung

- Binden Sie die Bridge an eine Tailnet-IP: `bridge.bind: "tailnet"` in
  `~/.openclaw/openclaw.json`.
- Clients verbinden sich über den MagicDNS-Namen oder die Tailnet-IP.
- Bonjour überquert **keine** Netzwerke; verwenden Sie bei Bedarf manuelle Host/Port-Angaben
  oder Wide-Area DNS‑SD.

## Versionierung

Die Bridge ist derzeit **implizit v1** (keine Min-/Max-Aushandlung). Abwärtskompatibilität
wird erwartet; fügen Sie vor jeglichen Breaking Changes ein Bridge-Protokoll-Versionsfeld hinzu.
