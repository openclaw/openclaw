---
summary: "„Mattermost-Bot-Einrichtung und OpenClaw-Konfiguration“"
read_when:
  - Mattermost einrichten
  - Mattermost-Routing debuggen
title: "Wichtigste"
---

# Mattermost (Plugin)

Status: unterstützt über Plugin (Bot-Token + WebSocket-Events). Kanäle, Gruppen und DMs werden unterstützt.
Mattermost ist eine selbst hostbare Team-Messaging-Plattform; siehe die offizielle Website unter
[mattermost.com](https://mattermost.com) für Produktdetails und Downloads.

## Plugin erforderlich

Mattermost wird als Plugin ausgeliefert und ist nicht im Core-Install enthalten.

Installation per CLI (npm-Registry):

```bash
openclaw plugins install @openclaw/mattermost
```

Lokales Checkout (bei Ausführung aus einem Git-Repo):

```bash
openclaw plugins install ./extensions/mattermost
```

Wenn Sie Mattermost während der Konfiguration/des Onboardings auswählen und ein Git-Checkout erkannt wird,
bietet OpenClaw den lokalen Installationspfad automatisch an.

Details: [Plugins](/tools/plugin)

## Schnellstart

1. Installieren Sie das Mattermost-Plugin.
2. Erstellen Sie ein Mattermost-Bot-Konto und kopieren Sie den **Bot-Token**.
3. Kopieren Sie die Mattermost-**Basis-URL** (z. B. `https://chat.example.com`).
4. Konfigurieren Sie OpenClaw und starten Sie das Gateway.

Minimale Konfiguration:

```json5
{
  channels: {
    mattermost: {
      enabled: true,
      botToken: "mm-token",
      baseUrl: "https://chat.example.com",
      dmPolicy: "pairing",
    },
  },
}
```

## Umgebungsvariablen (Standardkonto)

Setzen Sie diese auf dem Gateway-Host, wenn Sie Umgebungsvariablen bevorzugen:

- `MATTERMOST_BOT_TOKEN=...`
- `MATTERMOST_URL=https://chat.example.com`

Umgebungsvariablen gelten nur für das **Standard**-Konto (`default`). Andere Konten müssen Konfigurationswerte verwenden.

## Chat-Modi

Mattermost antwortet automatisch auf DMs. Das Verhalten in Kanälen wird über `chatmode` gesteuert:

- `oncall` (Standard): antwortet nur, wenn in Kanälen per @ erwähnt.
- `onmessage`: antwortet auf jede Nachricht im Kanal.
- `onchar`: antwortet, wenn eine Nachricht mit einem Trigger-Präfix beginnt.

Konfigurationsbeispiel:

```json5
{
  channels: {
    mattermost: {
      chatmode: "onchar",
      oncharPrefixes: [">", "!"],
    },
  },
}
```

Hinweise:

- `onchar` reagiert weiterhin auf explizite @Erwähnungen.
- `channels.mattermost.requireMention` wird für Legacy-Konfigurationen berücksichtigt, `chatmode` wird jedoch bevorzugt.

## Zugriffskontrolle (DMs)

- Standard: `channels.mattermost.dmPolicy = "pairing"` (unbekannte Absender erhalten einen Pairing-Code).
- Freigabe über:
  - `openclaw pairing list mattermost`
  - `openclaw pairing approve mattermost <CODE>`
- Öffentliche DMs: `channels.mattermost.dmPolicy="open"` plus `channels.mattermost.allowFrom=["*"]`.

## Kanäle (Gruppen)

- Standard: `channels.mattermost.groupPolicy = "allowlist"` (Erwähnung erforderlich).
- Allowlist-Absender mit `channels.mattermost.groupAllowFrom` (Benutzer-IDs oder `@username`).
- Offene Kanäle: `channels.mattermost.groupPolicy="open"` (Erwähnung erforderlich).

## Ziele für ausgehende Zustellung

Verwenden Sie diese Zielformate mit `openclaw message send` oder Cron/Webhooks:

- `channel:<id>` für einen Kanal
- `user:<id>` für eine DM
- `@username` für eine DM (über die Mattermost-API aufgelöst)

Reine IDs werden als Kanäle behandelt.

## Mehrere Konten

Mattermost unterstützt mehrere Konten unter `channels.mattermost.accounts`:

```json5
{
  channels: {
    mattermost: {
      accounts: {
        default: { name: "Primary", botToken: "mm-token", baseUrl: "https://chat.example.com" },
        alerts: { name: "Alerts", botToken: "mm-token-2", baseUrl: "https://alerts.example.com" },
      },
    },
  },
}
```

## Fehlerbehebung

- Keine Antworten in Kanälen: Stellen Sie sicher, dass der Bot im Kanal ist und erwähnt wird (oncall), verwenden Sie ein Trigger-Präfix (onchar) oder setzen Sie `chatmode: "onmessage"`.
- Authentifizierungsfehler: Prüfen Sie den Bot-Token, die Basis-URL und ob das Konto aktiviert ist.
- Probleme mit mehreren Konten: Umgebungsvariablen gelten nur für das `default`-Konto.
