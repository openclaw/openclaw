---
summary: "„Support-Status, Funktionen und Konfiguration des Zalo-Bots“"
read_when:
  - Arbeit an Zalo-Funktionen oder Webhooks
title: "„Zalo“"
---

# Zalo (Bot API)

Status: experimentell. Nur Direktnachrichten; Gruppen folgen laut Zalo-Dokumentation in Kürze.

## Plugin erforderlich

Zalo wird als Plugin bereitgestellt und ist nicht im Core-Installationspaket enthalten.

- Installation per CLI: `openclaw plugins install @openclaw/zalo`
- Oder **Zalo** während des Onboardings auswählen und die Installationsabfrage bestätigen
- Details: [Plugins](/tools/plugin)

## Schnellsetup (für Einsteiger)

1. Installieren Sie das Zalo-Plugin:
   - Aus einem Source-Checkout: `openclaw plugins install ./extensions/zalo`
   - Aus npm (falls veröffentlicht): `openclaw plugins install @openclaw/zalo`
   - Oder wählen Sie **Zalo** im Onboarding und bestätigen Sie die Installationsabfrage
2. Setzen Sie das Token:
   - Env: `ZALO_BOT_TOKEN=...`
   - Oder Konfiguration: `channels.zalo.botToken: "..."`.
3. Starten Sie das Gateway neu (oder schließen Sie das Onboarding ab).
4. DM-Zugriff ist standardmäßig per Pairing aktiviert; genehmigen Sie beim ersten Kontakt den Pairing-Code.

Minimale Konfiguration:

```json5
{
  channels: {
    zalo: {
      enabled: true,
      botToken: "12345689:abc-xyz",
      dmPolicy: "pairing",
    },
  },
}
```

## Was es ist

Zalo ist eine auf Vietnam fokussierte Messaging-App; die Bot API ermöglicht dem Gateway den Betrieb eines Bots für 1:1‑Unterhaltungen.
Es eignet sich gut für Support oder Benachrichtigungen, wenn eine deterministische Rückführung zu Zalo gewünscht ist.

- Ein Zalo-Bot-API‑Kanal, der dem Gateway gehört.
- Deterministisches Routing: Antworten gehen zurück zu Zalo; das Modell wählt keine Kanäle.
- DMs teilen sich die Hauptsitzung des Agenten.
- Gruppen werden noch nicht unterstützt (laut Zalo-Dokumentation „coming soon“).

## Setup (Schnellpfad)

### 1. Bot-Token erstellen (Zalo Bot Platform)

1. Rufen Sie [https://bot.zaloplatforms.com](https://bot.zaloplatforms.com) auf und melden Sie sich an.
2. Erstellen Sie einen neuen Bot und konfigurieren Sie die Einstellungen.
3. Kopieren Sie das Bot-Token (Format: `12345689:abc-xyz`).

### 2) Token konfigurieren (Env oder Konfiguration)

Beispiel:

```json5
{
  channels: {
    zalo: {
      enabled: true,
      botToken: "12345689:abc-xyz",
      dmPolicy: "pairing",
    },
  },
}
```

Env-Option: `ZALO_BOT_TOKEN=...` (funktioniert nur für das Standardkonto).

Mehrkonten-Unterstützung: Verwenden Sie `channels.zalo.accounts` mit kontospezifischen Tokens und optional `name`.

3. Starten Sie das Gateway neu. Zalo startet, sobald ein Token aufgelöst wird (Env oder Konfiguration).
4. DM-Zugriff ist standardmäßig Pairing. Genehmigen Sie den Code, wenn der Bot erstmals kontaktiert wird.

## Funktionsweise (Verhalten)

- Eingehende Nachrichten werden in den gemeinsamen Kanal‑Umschlag normalisiert, mit Media‑Platzhaltern.
- Antworten werden immer an denselben Zalo-Chat zurückgeleitet.
- Standardmäßig Long-Polling; Webhook-Modus verfügbar mit `channels.zalo.webhookUrl`.

## Limits

- Ausgehender Text wird auf 2000 Zeichen segmentiert (Zalo‑API‑Limit).
- Medien-Downloads/-Uploads sind durch `channels.zalo.mediaMaxMb` begrenzt (Standard 5).
- Streaming ist standardmäßig blockiert, da das 2000‑Zeichen‑Limit Streaming weniger sinnvoll macht.

## Zugriffskontrolle (DMs)

### DM-Zugriff

- Standard: `channels.zalo.dmPolicy = "pairing"`. Unbekannte Absender erhalten einen Pairing-Code; Nachrichten werden bis zur Genehmigung ignoriert (Codes verfallen nach 1 Stunde).
- Genehmigung über:
  - `openclaw pairing list zalo`
  - `openclaw pairing approve zalo <CODE>`
- Pairing ist der Standard‑Token‑Austausch. Details: [Pairing](/channels/pairing)
- `channels.zalo.allowFrom` akzeptiert numerische Benutzer-IDs (keine Benutzernamen‑Auflösung verfügbar).

## Long-Polling vs. Webhook

- Standard: Long-Polling (keine öffentliche URL erforderlich).
- Webhook‑Modus: Setzen Sie `channels.zalo.webhookUrl` und `channels.zalo.webhookSecret`.
  - Das Webhook‑Secret muss 8–256 Zeichen lang sein.
  - Die Webhook‑URL muss HTTPS verwenden.
  - Zalo sendet Events mit dem Header `X-Bot-Api-Secret-Token` zur Verifizierung.
  - Gateway HTTP verarbeitet Webhook‑Anfragen unter `channels.zalo.webhookPath` (standardmäßig der Pfad der Webhook‑URL).

**Hinweis:** getUpdates (Polling) und Webhook sind gemäß Zalo‑API‑Dokumentation gegenseitig exklusiv.

## Unterstützte Nachrichtentypen

- **Textnachrichten**: Vollständig unterstützt mit 2000‑Zeichen‑Segmentierung.
- **Bildnachrichten**: Download und Verarbeitung eingehender Bilder; Senden von Bildern über `sendPhoto`.
- **Sticker**: Protokolliert, aber nicht vollständig verarbeitet (keine Agentenantwort).
- **Nicht unterstützte Typen**: Protokolliert (z. B. Nachrichten von geschützten Benutzern).

## Funktionen

| Funktion                           | Status                                               |
| ---------------------------------- | ---------------------------------------------------- |
| Direktnachrichten                  | ✅ Unterstützt                                        |
| Gruppen                            | ❌ Coming soon (laut Zalo‑Doku)    |
| Medien (Bilder) | ✅ Unterstützt                                        |
| Reaktionen                         | ❌ Nicht unterstützt                                  |
| Threads                            | ❌ Nicht unterstützt                                  |
| Umfragen                           | ❌ Nicht unterstützt                                  |
| Native Befehle                     | ❌ Nicht unterstützt                                  |
| Streaming                          | ⚠️ Blockiert (2000‑Zeichen‑Limit) |

## Zieladressen für Zustellung (CLI/Cron)

- Verwenden Sie eine Chat‑ID als Ziel.
- Beispiel: `openclaw message send --channel zalo --target 123456789 --message "hi"`.

## Fehlerbehebung

**Bot reagiert nicht:**

- Prüfen Sie, ob das Token gültig ist: `openclaw channels status --probe`
- Verifizieren Sie, dass der Absender genehmigt ist (Pairing oder allowFrom)
- Prüfen Sie die Gateway‑Logs: `openclaw logs --follow`

**Webhook empfängt keine Events:**

- Stellen Sie sicher, dass die Webhook‑URL HTTPS verwendet
- Verifizieren Sie, dass das Secret 8–256 Zeichen lang ist
- Bestätigen Sie, dass der Gateway‑HTTP‑Endpoint unter dem konfigurierten Pfad erreichbar ist
- Prüfen Sie, dass getUpdates‑Polling nicht läuft (gegenseitig exklusiv)

## Konfigurationsreferenz (Zalo)

Vollständige Konfiguration: [Konfiguration](/gateway/configuration)

Anbieter‑Optionen:

- `channels.zalo.enabled`: Kanalstart aktivieren/deaktivieren.
- `channels.zalo.botToken`: Bot‑Token von der Zalo Bot Platform.
- `channels.zalo.tokenFile`: Token aus einem Dateipfad lesen.
- `channels.zalo.dmPolicy`: `pairing | allowlist | open | disabled` (Standard: Pairing).
- `channels.zalo.allowFrom`: DM‑Allowlist (Benutzer‑IDs). `open` erfordert `"*"`. Der Assistent fragt nach numerischen IDs.
- `channels.zalo.mediaMaxMb`: Limit für eingehende/ausgehende Medien (MB, Standard 5).
- `channels.zalo.webhookUrl`: Webhook‑Modus aktivieren (HTTPS erforderlich).
- `channels.zalo.webhookSecret`: Webhook‑Secret (8–256 Zeichen).
- `channels.zalo.webhookPath`: Webhook‑Pfad auf dem Gateway‑HTTP‑Server.
- `channels.zalo.proxy`: Proxy‑URL für API‑Anfragen.

Mehrkonten‑Optionen:

- `channels.zalo.accounts.<id>.botToken`: Kontospezifisches Token.
- `channels.zalo.accounts.<id>.tokenFile`: Kontospezifische Token‑Datei.
- `channels.zalo.accounts.<id>.name`: Anzeigename.
- `channels.zalo.accounts.<id>.enabled`: Konto aktivieren/deaktivieren.
- `channels.zalo.accounts.<id>.dmPolicy`: Kontospezifische DM‑Richtlinie.
- `channels.zalo.accounts.<id>.allowFrom`: Kontospezifische Allowlist.
- `channels.zalo.accounts.<id>.webhookUrl`: Kontospezifische Webhook‑URL.
- `channels.zalo.accounts.<id>.webhookSecret`: Kontospezifisches Webhook‑Secret.
- `channels.zalo.accounts.<id>.webhookPath`: Kontospezifischer Webhook‑Pfad.
- `channels.zalo.accounts.<id>.proxy`: Kontospezifische Proxy‑URL.
