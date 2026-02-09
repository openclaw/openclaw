---
summary: "Konfiguration av Mattermost-bot och OpenClaw-konfig"
read_when:
  - Konfigurera Mattermost
  - Felsöka Mattermost-routning
title: "Mattermost"
---

# Mattermost (plugin)

Status: stöds via plugin (bot-token + WebSocket-händelser). Kanaler, grupper och DMs stöds.
Mattermost är en plattform för teammeddelande; se den officiella webbplatsen på
[mattermost.com](https://mattermost.com) för produktdetaljer och nedladdningar.

## Plugin krävs

Mattermost levereras som ett plugin och ingår inte i kärninstallationen.

Installera via CLI (npm-registret):

```bash
openclaw plugins install @openclaw/mattermost
```

Lokal checkout (när du kör från ett git-repo):

```bash
openclaw plugins install ./extensions/mattermost
```

Om du väljer Mattermost under konfigurering/introduktion och en git-checkout upptäcks,
erbjuder OpenClaw automatiskt den lokala installationssökvägen.

Detaljer: [Plugins](/tools/plugin)

## Snabbstart

1. Installera Mattermost-pluginet.
2. Skapa ett Mattermost-botkonto och kopiera **bot-token**.
3. Kopiera Mattermost **bas-URL** (t.ex., 'https://chat.example.com').
4. Konfigurera OpenClaw och starta gatewayn.

Minimal konfig:

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

## Miljövariabler (standardkonto)

Sätt dessa på gateway-värden om du föredrar miljövariabler:

- `MATTERMOST_BOT_TOKEN=...`
- `MATTERMOST_URL=https://chat.example.com`

Env vars gäller endast för kontot **standard** (`default`). Andra konton måste använda konfigurationsvärden.

## Chattlägen

Mattermost svarar på DMs automatiskt. Kanalbeteende styrs av `chatmode`:

- `oncall` (standard): svara endast när boten @omnämns i kanaler.
- `onmessage`: svara på varje kanalmeddelande.
- `onchar`: svara när ett meddelande börjar med ett trigger-prefix.

Konfigexempel:

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

Noteringar:

- `onchar` svarar fortfarande på explicita @omnämnanden.
- `channels.mattermost.requireMention` respekteras för äldre konfigar men `chatmode` föredras.

## Åtkomstkontroll (DM:er)

- Standard: `channels.mattermost.dmPolicy = "pairing"` (okända avsändare får en parningskod).
- Godkänn via:
  - `openclaw pairing list mattermost`
  - `openclaw pairing approve mattermost <CODE>`
- Offentliga DM:er: `channels.mattermost.dmPolicy="open"` plus `channels.mattermost.allowFrom=["*"]`.

## Kanaler (grupper)

- Standard: `channels.mattermost.groupPolicy = "allowlist"` (omnämningsstyrt).
- Tillåtelselista av avsändare med `channels.mattermost.groupAllowFrom` (användar-ID:n eller `@username`).
- Öppna kanaler: `channels.mattermost.groupPolicy="open"` (omnämningsstyrt).

## Mål för utgående leverans

Använd dessa målformat med `openclaw message send` eller cron/webhooks:

- `channel:<id>` för en kanal
- `user:<id>` för en DM
- `@username` för en DM (upplöst via Mattermost-API:t)

Rena ID:n behandlas som kanaler.

## Flerkonton

Mattermost stöder flera konton under `channels.mattermost.accounts`:

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

## Felsökning

- Inga svar i kanaler: säkerställ att boten är med i kanalen och omnämn den (oncall), använd ett trigger-prefix (onchar) eller sätt `chatmode: "onmessage"`.
- Autentiseringsfel: kontrollera bot-token, bas-URL och om kontot är aktiverat.
- Flerkontoproblem: miljövariabler gäller endast för `default`-kontot.
