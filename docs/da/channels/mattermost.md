---
summary: "Opsætning af Mattermost-bot og OpenClaw-konfiguration"
read_when:
  - Opsætning af Mattermost
  - Fejlfinding af Mattermost-routing
title: "Mattermost"
---

# Mattermost (plugin)

Status: understøttet via plugin (bot token + WebSocket events). Kabelkanaler, grupper og DM'er understøttes.
Mattermost er en selv-hostable team messaging platform; se den officielle hjemmeside på
[mattermost.com](https://mattermost.com) for produktoplysninger og downloads.

## Plugin påkrævet

Mattermost leveres som et plugin og er ikke inkluderet i kerneinstallationen.

Installér via CLI (npm-registret):

```bash
openclaw plugins install @openclaw/mattermost
```

Lokalt checkout (ved kørsel fra et git-repo):

```bash
openclaw plugins install ./extensions/mattermost
```

Hvis du vælger Mattermost under konfiguration/introduktion, og et git-checkout registreres,
vil OpenClaw automatisk tilbyde den lokale installationssti.

Detaljer: [Plugins](/tools/plugin)

## Hurtig opsætning

1. Installér Mattermost-pluginet.
2. Opret en Mattermost-botkonto og kopiér **bot-token**.
3. Kopier den mest betydningsfulde **base-URL** (f.eks. `https://chat.example.com`).
4. Konfigurér OpenClaw og start gateway.

Minimal konfiguration:

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

## Miljøvariabler (standardkonto)

Sæt disse på gateway-værten, hvis du foretrækker miljøvariabler:

- `MATTERMOST_BOT_TOKEN=...`
- `MATTERMOST_URL=https://chat.example.com`

Env vars gælder kun for **default** kontoen (`default`). Andre konti skal bruge konfigurationsværdier.

## Chattilstande

Mattermost reagerer automatisk på DM'er. Kanal adfærd styres af `chatmode`:

- `oncall` (standard): svar kun ved @omtale i kanaler.
- `onmessage`: svar på hver kanalbesked.
- `onchar`: svar når en besked starter med et trigger-præfiks.

Konfigurationseksempel:

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

Noter:

- `onchar` svarer stadig på eksplicitte @omtaler.
- `channels.mattermost.requireMention` respekteres for ældre konfigurationer, men `chatmode` foretrækkes.

## Adgangskontrol (DMs)

- Standard: `channels.mattermost.dmPolicy = "pairing"` (ukendte afsendere får en parringskode).
- Godkend via:
  - `openclaw pairing list mattermost`
  - `openclaw pairing approve mattermost <CODE>`
- Offentlige DMs: `channels.mattermost.dmPolicy="open"` plus `channels.mattermost.allowFrom=["*"]`.

## Kanaler (grupper)

- Standard: `channels.mattermost.groupPolicy = "allowlist"` (omtale-krævet).
- Tilladelsesliste for afsendere med `channels.mattermost.groupAllowFrom` (bruger-id’er eller `@username`).
- Åbne kanaler: `channels.mattermost.groupPolicy="open"` (omtale-krævet).

## Mål for udgående levering

Brug disse målformater med `openclaw message send` eller cron/webhooks:

- `channel:<id>` for en kanal
- `user:<id>` for en DM
- `@username` for en DM (løst via Mattermost API’et)

Rene id’er behandles som kanaler.

## Flere konti

Mattermost understøtter flere konti under `channels.mattermost.accounts`:

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

## Fejlfinding

- Ingen svar i kanaler: sørg for, at botten er i kanalen og @omtales (oncall), brug et trigger-præfiks (onchar), eller sæt `chatmode: "onmessage"`.
- Autentificeringsfejl: tjek bot-token, base-URL og om kontoen er aktiveret.
- Problemer med flere konti: miljøvariabler gælder kun for `default`-kontoen.
