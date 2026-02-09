---
summary: "Mattermost-botinstallatie en OpenClaw-configuratie"
read_when:
  - Mattermost instellen
  - Mattermost-routering debuggen
title: "Mattermost"
---

# Mattermost (plugin)

Status: ondersteund via plugin (bot-token + WebSocket-events). Kanalen, groepen en DM's worden ondersteund.
Mattermost is een zelf-hostbaar teamchatplatform; zie de officiële site op
[mattermost.com](https://mattermost.com) voor productdetails en downloads.

## Plugin vereist

Mattermost wordt geleverd als plugin en is niet gebundeld met de kerninstallatie.

Installeren via CLI (npm-registry):

```bash
openclaw plugins install @openclaw/mattermost
```

Lokale checkout (bij uitvoeren vanuit een git-repo):

```bash
openclaw plugins install ./extensions/mattermost
```

Als je Mattermost kiest tijdens configuratie/onboarding en een git-checkout wordt gedetecteerd,
biedt OpenClaw automatisch het lokale installatiepad aan.

Details: [Plugins](/tools/plugin)

## Snelle installatie

1. Installeer de Mattermost-plugin.
2. Maak een Mattermost-botaccount aan en kopieer de **bot-token**.
3. Kopieer de Mattermost **basis-URL** (bijv. `https://chat.example.com`).
4. Configureer OpenClaw en start de gateway.

Minimale config:

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

## Omgevingsvariabelen (standaardaccount)

Stel deze in op de Gateway-host als je liever env vars gebruikt:

- `MATTERMOST_BOT_TOKEN=...`
- `MATTERMOST_URL=https://chat.example.com`

Env vars zijn alleen van toepassing op het **standaard** account (`default`). Andere accounts moeten configwaarden gebruiken.

## Chatmodi

Mattermost reageert automatisch op DM's. Gedrag in kanalen wordt bepaald door `chatmode`:

- `oncall` (standaard): reageer alleen wanneer @vermeld in kanalen.
- `onmessage`: reageer op elk kanaalbericht.
- `onchar`: reageer wanneer een bericht begint met een triggerprefix.

Config-voorbeeld:

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

Notities:

- `onchar` reageert nog steeds op expliciete @vermeldingen.
- `channels.mattermost.requireMention` wordt gehonoreerd voor legacy-configs, maar `chatmode` heeft de voorkeur.

## Toegangsbeheer (DM's)

- Standaard: `channels.mattermost.dmPolicy = "pairing"` (onbekende afzenders krijgen een koppelingscode).
- Goedkeuren via:
  - `openclaw pairing list mattermost`
  - `openclaw pairing approve mattermost <CODE>`
- Openbare DM's: `channels.mattermost.dmPolicy="open"` plus `channels.mattermost.allowFrom=["*"]`.

## Kanalen (groepen)

- Standaard: `channels.mattermost.groupPolicy = "allowlist"` (vermelding-gebonden).
- Sta afzenders toe via een toegestane lijst met `channels.mattermost.groupAllowFrom` (gebruikers-ID's of `@username`).
- Open kanalen: `channels.mattermost.groupPolicy="open"` (vermelding-gebonden).

## Doelen voor uitgaande levering

Gebruik deze doelformaten met `openclaw message send` of cron/webhooks:

- `channel:<id>` voor een kanaal
- `user:<id>` voor een DM
- `@username` voor een DM (opgelost via de Mattermost API)

Kale ID's worden behandeld als kanalen.

## Meerdere accounts

Mattermost ondersteunt meerdere accounts onder `channels.mattermost.accounts`:

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

## Problemen oplossen

- Geen reacties in kanalen: zorg dat de bot in het kanaal zit en vermeld hem (oncall), gebruik een triggerprefix (onchar), of stel `chatmode: "onmessage"` in.
- Auth-fouten: controleer de bot-token, basis-URL en of het account is ingeschakeld.
- Problemen met meerdere accounts: env vars zijn alleen van toepassing op het `default` account.
