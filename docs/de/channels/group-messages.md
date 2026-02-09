---
summary: "„Verhalten und Konfiguration für die Verarbeitung von WhatsApp-Gruppennachrichten (mentionPatterns werden kanalübergreifend geteilt)“"
read_when:
  - Ändern von Regeln für Gruppennachrichten oder Erwähnungen
title: "„Gruppennachrichten“"
---

# Gruppennachrichten (WhatsApp-Web-Kanal)

Ziel: Clawd soll in WhatsApp-Gruppen mitlesen, nur bei einem Ping aktiv werden und diesen Thread von der persönlichen DM-Sitzung getrennt halten.

Hinweis: `agents.list[].groupChat.mentionPatterns` wird inzwischen auch von Telegram/Discord/Slack/iMessage verwendet; dieses Dokument konzentriert sich auf WhatsApp-spezifisches Verhalten. Für Multi-Agent-Setups setzen Sie `agents.list[].groupChat.mentionPatterns` pro Agent (oder verwenden Sie `messages.groupChat.mentionPatterns` als globalen Fallback).

## Was implementiert ist (2025-12-03)

- Aktivierungsmodi: `mention` (Standard) oder `always`. `mention` erfordert einen Ping (echte WhatsApp-@-Erwähnungen über `mentionedJids`, Regex-Muster oder die E.164-Nummer des Bots irgendwo im Text). `always` weckt den Agenten bei jeder Nachricht, aber er sollte nur antworten, wenn er einen sinnvollen Mehrwert liefern kann; andernfalls gibt er das stille Token `NO_REPLY` zurück. Standardwerte können in der Konfiguration gesetzt werden (`channels.whatsapp.groups`) und pro Gruppe über `/activation` überschrieben werden. Wenn `channels.whatsapp.groups` gesetzt ist, fungiert es zusätzlich als Gruppen-Allowlist (fügen Sie `"*"` hinzu, um alle zuzulassen).
- Gruppenrichtlinie: `channels.whatsapp.groupPolicy` steuert, ob Gruppennachrichten akzeptiert werden (`open|disabled|allowlist`). `allowlist` verwendet `channels.whatsapp.groupAllowFrom` (Fallback: explizites `channels.whatsapp.allowFrom`). Standard ist `allowlist` (blockiert, bis Sie Absender hinzufügen).
- Pro-Gruppen-Sitzungen: Sitzungsschlüssel sehen aus wie `agent:<agentId>:whatsapp:group:<jid>`, sodass Befehle wie `/verbose on` oder `/think high` (als eigenständige Nachrichten gesendet) auf diese Gruppe beschränkt sind; der persönliche DM-Status bleibt unberührt. Heartbeats werden für Gruppenthreads übersprungen.
- Kontext-Injektion: **nur ausstehende** Gruppennachrichten (Standard: 50), die _keinen_ Lauf ausgelöst haben, werden unter `[Chat messages since your last reply - for context]` vorangestellt, wobei die auslösende Zeile unter `[Current message - respond to this]` steht. Nachrichten, die bereits in der Sitzung sind, werden nicht erneut injiziert.
- Absender-Kennzeichnung: Jeder Gruppenbatch endet jetzt mit `[from: Sender Name (+E164)]`, damit Pi weiß, wer spricht.
- Ephemeral/View-once: Diese werden vor der Textextraktion/Erwähnungsanalyse entpackt, sodass Pings darin weiterhin auslösen.
- Gruppen-Systemprompt: Beim ersten Zug einer Gruppensitzung (und immer dann, wenn `/activation` den Modus ändert) injizieren wir einen kurzen Hinweis in den Systemprompt wie `You are replying inside the WhatsApp group "<subject>". Group members: Alice (+44...), Bob (+43...), … Activation: trigger-only … Address the specific sender noted in the message context.`. Wenn Metadaten nicht verfügbar sind, teilen wir dem Agenten dennoch mit, dass es sich um einen Gruppenchat handelt.

## Konfigurationsbeispiel (WhatsApp)

Fügen Sie einen `groupChat`-Block zu `~/.openclaw/openclaw.json` hinzu, damit Display-Name-Pings funktionieren, selbst wenn WhatsApp das visuelle `@` im Textkörper entfernt:

```json5
{
  channels: {
    whatsapp: {
      groups: {
        "*": { requireMention: true },
      },
    },
  },
  agents: {
    list: [
      {
        id: "main",
        groupChat: {
          historyLimit: 50,
          mentionPatterns: ["@?openclaw", "\\+?15555550123"],
        },
      },
    ],
  },
}
```

Hinweise:

- Die Regexe sind nicht groß-/kleinschreibungssensitiv; sie decken einen Display-Name-Ping wie `@openclaw` sowie die rohe Nummer mit oder ohne `+`/Leerzeichen ab.
- WhatsApp sendet weiterhin kanonische Erwähnungen über `mentionedJids`, wenn jemand auf den Kontakt tippt; daher ist der Nummern-Fallback selten nötig, aber ein nützliches Sicherheitsnetz.

### Aktivierungsbefehl (nur Eigentümer)

Verwenden Sie den Gruppenchat-Befehl:

- `/activation mention`
- `/activation always`

Nur die Eigentümernummer (aus `channels.whatsapp.allowFrom` oder die E.164-Nummer des Bots, wenn nicht gesetzt) kann dies ändern. Senden Sie `/status` als eigenständige Nachricht in die Gruppe, um den aktuellen Aktivierungsmodus anzuzeigen.

## Verwendung

1. Fügen Sie Ihr WhatsApp-Konto (das OpenClaw ausführt) der Gruppe hinzu.
2. Sagen Sie `@openclaw …` (oder fügen Sie die Nummer ein). Nur Absender auf der Allowlist können es auslösen, es sei denn, Sie setzen `groupPolicy: "open"`.
3. Der Agenten-Prompt enthält den aktuellen Gruppen­kontext sowie den abschließenden `[from: …]`-Marker, damit er die richtige Person adressiert.
4. Sitzungsweite Direktiven (`/verbose on`, `/think high`, `/new` oder `/reset`, `/compact`) gelten nur für die Sitzung dieser Gruppe; senden Sie sie als eigenständige Nachrichten, damit sie registriert werden. Ihre persönliche DM-Sitzung bleibt unabhängig.

## Testen / Verifikation

- Manueller Smoke-Test:
  - Senden Sie einen `@openclaw`-Ping in der Gruppe und bestätigen Sie eine Antwort, die den Absendernamen referenziert.
  - Senden Sie einen zweiten Ping und prüfen Sie, dass der Verlaufsblock enthalten ist und im nächsten Zug wieder geleert wird.
- Prüfen Sie die Gateway-Logs (ausführen mit `--verbose`), um `inbound web message`-Einträge zu sehen, die `from: <groupJid>` und das `[from: …]`-Suffix anzeigen.

## Bekannte Hinweise

- Heartbeats werden für Gruppen bewusst übersprungen, um laute Broadcasts zu vermeiden.
- Die Echo-Unterdrückung verwendet den kombinierten Batch-String; wenn Sie identischen Text zweimal ohne Erwähnungen senden, erhält nur der erste eine Antwort.
- Sitzungsspeichereinträge erscheinen als `agent:<agentId>:whatsapp:group:<jid>` im Sitzungsspeicher (`~/.openclaw/agents/<agentId>/sessions/sessions.json` standardmäßig); ein fehlender Eintrag bedeutet lediglich, dass die Gruppe noch keinen Lauf ausgelöst hat.
- Tippindikatoren in Gruppen folgen `agents.defaults.typingMode` (Standard: `message` bei fehlender Erwähnung).
