---
summary: „Pairing-Überblick: genehmigen, wer Ihnen Direktnachrichten senden darf + welche Nodes dem Netzwerk beitreten können“
read_when:
  - Einrichten der Zugriffskontrolle für Direktnachrichten
  - Pairing eines neuen iOS-/Android-Nodes
  - Überprüfung der Sicherheitslage von OpenClaw
title: „Pairing“
x-i18n:
  source_path: channels/pairing.md
  source_hash: cc6ce9c71db6d96d
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:35:18Z
---

# Pairing

„Pairing“ ist der explizite Schritt zur **Genehmigung durch den Eigentümer** in OpenClaw.
Er wird an zwei Stellen verwendet:

1. **DM-Pairing** (wer mit dem Bot sprechen darf)
2. **Node-Pairing** (welche Geräte/Nodes dem Gateway-Netzwerk beitreten dürfen)

Sicherheitskontext: [Security](/gateway/security)

## 1) DM-Pairing (eingehender Chat-Zugriff)

Wenn ein Kanal mit der DM-Richtlinie `pairing` konfiguriert ist, erhalten unbekannte Absender einen Kurzcode und ihre Nachricht wird **nicht verarbeitet**, bis Sie genehmigen.

Standard-DM-Richtlinien sind dokumentiert unter: [Security](/gateway/security)

Pairing-Codes:

- 8 Zeichen, Großbuchstaben, keine mehrdeutigen Zeichen (`0O1I`).
- **Laufen nach 1 Stunde ab**. Der Bot sendet die Pairing-Nachricht nur, wenn eine neue Anfrage erstellt wird (ungefähr einmal pro Stunde und Absender).
- Ausstehende DM-Pairing-Anfragen sind standardmäßig auf **3 pro Kanal** begrenzt; zusätzliche Anfragen werden ignoriert, bis eine abläuft oder genehmigt wird.

### Absender genehmigen

```bash
openclaw pairing list telegram
openclaw pairing approve telegram <CODE>
```

Unterstützte Kanäle: `telegram`, `whatsapp`, `signal`, `imessage`, `discord`, `slack`.

### Wo der Status gespeichert wird

Gespeichert unter `~/.openclaw/credentials/`:

- Ausstehende Anfragen: `<channel>-pairing.json`
- Genehmigte Allowlist-Speicher: `<channel>-allowFrom.json`

Behandeln Sie diese Daten als sensibel (sie steuern den Zugriff auf Ihren Assistenten).

## 2) Node-Geräte-Pairing (iOS-/Android-/macOS-/headless Nodes)

Nodes verbinden sich als **Geräte** mit dem Gateway mit `role: node`. Das Gateway
erstellt eine Geräte-Pairing-Anfrage, die genehmigt werden muss.

### Node-Gerät genehmigen

```bash
openclaw devices list
openclaw devices approve <requestId>
openclaw devices reject <requestId>
```

### Speicherung des Node-Pairing-Status

Gespeichert unter `~/.openclaw/devices/`:

- `pending.json` (kurzlebig; ausstehende Anfragen laufen ab)
- `paired.json` (gepaarte Geräte + Tokens)

### Hinweise

- Die veraltete `node.pair.*`-API (CLI: `openclaw nodes pending/approve`) ist ein
  separates, gateway-eigenes Pairing-Repository. WS-Nodes erfordern weiterhin Geräte-Pairing.

## Verwandte Dokumente

- Sicherheitsmodell + Prompt Injection: [Security](/gateway/security)
- Sicher aktualisieren (Doctor ausführen): [Updating](/install/updating)
- Kanal-Konfigurationen:
  - Telegram: [Telegram](/channels/telegram)
  - WhatsApp: [WhatsApp](/channels/whatsapp)
  - Signal: [Signal](/channels/signal)
  - BlueBubbles (iMessage): [BlueBubbles](/channels/bluebubbles)
  - iMessage (legacy): [iMessage](/channels/imessage)
  - Discord: [Discord](/channels/discord)
  - Slack: [Slack](/channels/slack)
