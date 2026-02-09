---
summary: "„Schnelle kanalbezogene Fehlerbehebung mit kanalspezifischen Fehlersignaturen und Korrekturen“"
read_when:
  - Der Kanal-Transport meldet verbunden, aber Antworten schlagen fehl
  - Sie benötigen kanalspezifische Prüfungen vor dem Einstieg in tiefe Anbieter-Dokumentation
title: "„Kanal-Fehlerbehebung“"
---

# Kanal-Fehlerbehebung

Verwenden Sie diese Seite, wenn ein Kanal verbindet, sich das Verhalten aber falsch zeigt.

## Befehlsleiter

Führen Sie diese zuerst der Reihe nach aus:

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

Gesunde Basislinie:

- `Runtime: running`
- `RPC probe: ok`
- Kanal-Probe zeigt verbunden/bereit

## WhatsApp

### WhatsApp-Fehlersignaturen

| Symptom                               | Schnellste Prüfung                                                  | Fix                                                                                              |
| ------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Verbunden, aber keine DM-Antworten    | `openclaw pairing list whatsapp`                                    | Absender genehmigen oder DM-Richtlinie/Allowlist wechseln.                       |
| Gruppenmeldungen werden ignoriert     | Prüfen Sie `requireMention` + Erwähnungsmuster in der Konfiguration | Erwähnen Sie den Bot oder lockern Sie die Erwähnungsrichtlinie für diese Gruppe. |
| Zufällige Trenn-/Neuanmelde-Schleifen | `openclaw channels status --probe` + Logs                           | Neu anmelden und verifizieren Anmeldedaten Verzeichnis ist gesund.               |

Vollständige Fehlerbehebung: [/channels/whatsapp#troubleshooting-quick](/channels/whatsapp#troubleshooting-quick)

## Telegram

### Telegram-Fehlersignaturen

| Symptom                                   | Schnellste Prüfung                                     | Fix                                                                                      |
| ----------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `/start` aber kein nutzbarer Antwortfluss | `openclaw pairing list telegram`                       | Kopplung genehmigen oder DM-Richtlinie ändern.                           |
| Bot online, aber Gruppe bleibt still      | Erwähnungspflicht und Datenschutzmodus des Bots prüfen | Datenschutzmodus für Gruppensichtbarkeit deaktivieren oder Bot erwähnen. |
| Sende-Fehler mit Netzwerkfehlern          | Logs auf Telegram-API-Aufruf-Fehler prüfen             | DNS/IPv6/Proxy-Routing zu `api.telegram.org` korrigieren.                |

Vollständige Fehlerbehebung: [/channels/telegram#troubleshooting](/channels/telegram#troubleshooting)

## Discord

### Discord-Fehlersignaturen

| Symptom                                | Schnellste Prüfung                      | Fix                                                                               |
| -------------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------- |
| Bot online, aber keine Guild-Antworten | `openclaw channels status --probe`      | Guild/Kanal erlauben und Message-Content-Intent prüfen.           |
| Gruppenmeldungen werden ignoriert      | Logs auf Erwähnungs-Gating-Drops prüfen | Bot erwähnen oder Guild/Kanal auf `requireMention: false` setzen. |
| DM-Antworten fehlen                    | `openclaw pairing list discord`         | DM-Kopplung genehmigen oder DM-Richtlinie anpassen.               |

Vollständige Fehlerbehebung: [/channels/discord#troubleshooting](/channels/discord#troubleshooting)

## Slack

### Slack-Fehlersignaturen

| Symptom                                      | Schnellste Prüfung                       | Fix                                                                    |
| -------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------- |
| Socket-Modus verbunden, aber keine Antworten | `openclaw channels status --probe`       | App-Token + Bot-Token und erforderliche Scopes prüfen. |
| DMs blockiert                                | `openclaw pairing list slack`            | Kopplung genehmigen oder DM-Richtlinie lockern.        |
| Kanalnachricht wird ignoriert                | `groupPolicy` und Kanal-Allowlist prüfen | Kanal erlauben oder Richtlinie auf `open` umstellen.   |

Vollständige Fehlerbehebung: [/channels/slack#troubleshooting](/channels/slack#troubleshooting)

## iMessage und BlueBubbles

### iMessage- und BlueBubbles-Fehlersignaturen

| Symptom                                         | Schnellste Prüfung                                                        | Fix                                                                              |
| ----------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Keine eingehenden Ereignisse                    | Webhook-/Server-Erreichbarkeit und App-Berechtigungen prüfen              | Webhook-URL oder BlueBubbles-Serverzustand korrigieren.          |
| Senden möglich, aber kein Empfangen unter macOS | macOS-Datenschutzberechtigungen für Messages-Automatisierung prüfen       | TCC-Berechtigungen erneut erteilen und Kanalprozess neu starten. |
| DM-Absender blockiert                           | `openclaw pairing list imessage` oder `openclaw pairing list bluebubbles` | Kopplung genehmigen oder Allowlist aktualisieren.                |

Vollständige Fehlerbehebung:

- [/channels/imessage#troubleshooting-macos-privacy-and-security-tcc](/channels/imessage#troubleshooting-macos-privacy-and-security-tcc)
- [/channels/bluebubbles#troubleshooting](/channels/bluebubbles#troubleshooting)

## Signal

### Signal-Fehlersignaturen

| Symptom                                 | Schnellste Prüfung                            | Fix                                                                     |
| --------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------- |
| Daemon erreichbar, aber Bot stumm       | `openclaw channels status --probe`            | `signal-cli`-Daemon-URL/Konto und Empfangsmodus prüfen. |
| DM blockiert                            | `openclaw pairing list signal`                | Absender genehmigen oder DM-Richtlinie anpassen.        |
| Gruppenantworten werden nicht ausgelöst | Gruppen-Allowlist und Erwähnungsmuster prüfen | Absender/Gruppe hinzufügen oder Gating lockern.         |

Vollständige Fehlerbehebung: [/channels/signal#troubleshooting](/channels/signal#troubleshooting)

## Matrix

### Matrix-Fehlersignaturen

| Symptom                                     | Schnellste Prüfung                                   | Fix                                                                                                 |
| ------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Angemeldet, ignoriert aber Raum-Nachrichten | `openclaw channels status --probe`                   | `groupPolicy` und Raum-Allowlist prüfen.                                            |
| DMs werden nicht verarbeitet                | `openclaw pairing list matrix`                       | Absender genehmigen oder DM-Richtlinie anpassen.                                    |
| Verschlüsselte Räume schlagen fehl          | Kryptomodul und Verschlüsselungseinstellungen prüfen | Verschlüsselungsunterstützung aktivieren und Raum erneut beitreten/synchronisieren. |

Vollständige Fehlerbehebung: [/channels/matrix#troubleshooting](/channels/matrix#troubleshooting)
