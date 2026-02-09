---
summary: "Ondersteuningsstatus, mogelijkheden en configuratie van de Zalo-bot"
read_when:
  - Werken aan Zalo-functies of webhooks
title: "Zalo"
---

# Zalo (Bot API)

Status: experimenteel. Alleen directe berichten; groepen komen binnenkort volgens de Zalo-documentatie.

## Plugin vereist

Zalo wordt geleverd als een plugin en is niet inbegrepen bij de kerninstallatie.

- Installeren via CLI: `openclaw plugins install @openclaw/zalo`
- Of selecteer **Zalo** tijdens onboarding en bevestig de installatieprompt
- Details: [Plugins](/tools/plugin)

## Snelle installatie (beginner)

1. Installeer de Zalo-plugin:
   - Vanuit een broncheckout: `openclaw plugins install ./extensions/zalo`
   - Vanuit npm (indien gepubliceerd): `openclaw plugins install @openclaw/zalo`
   - Of kies **Zalo** tijdens onboarding en bevestig de installatieprompt
2. Stel de token in:
   - Env: `ZALO_BOT_TOKEN=...`
   - Of config: `channels.zalo.botToken: "..."`.
3. Herstart de Gateway (of rond onboarding af).
4. DM-toegang is standaard via koppeling; keur de koppelingscode goed bij het eerste contact.

Minimale config:

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

## Wat het is

Zalo is een op Vietnam gerichte berichtenapp; de Bot API laat de Gateway een bot draaien voor 1-op-1-gesprekken.
Het is geschikt voor support of notificaties waarbij je deterministische routering terug naar Zalo wilt.

- Een Zalo Bot API-kanaal dat eigendom is van de Gateway.
- Deterministische routering: antwoorden gaan terug naar Zalo; het model kiest nooit kanalen.
- DM's delen de hoofdsessie van de agent.
- Groepen worden nog niet ondersteund (Zalo-documentatie vermeldt "coming soon").

## Installatie (snelle route)

### 1. Maak een bot-token aan (Zalo Bot Platform)

1. Ga naar [https://bot.zaloplatforms.com](https://bot.zaloplatforms.com) en meld je aan.
2. Maak een nieuwe bot aan en configureer de instellingen.
3. Kopieer de bot-token (formaat: `12345689:abc-xyz`).

### 2) Configureer de token (env of config)

Voorbeeld:

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

Env-optie: `ZALO_BOT_TOKEN=...` (werkt alleen voor het standaardaccount).

Ondersteuning voor meerdere accounts: gebruik `channels.zalo.accounts` met per-account tokens en optioneel `name`.

3. Herstart de Gateway. Zalo start wanneer een token is gevonden (env of config).
4. DM-toegang staat standaard op koppeling. Keur de code goed wanneer de bot voor het eerst wordt gecontacteerd.

## Hoe het werkt (gedrag)

- Inkomende berichten worden genormaliseerd naar de gedeelde kanaalomslag met mediaplaatsaanduidingen.
- Antwoorden worden altijd teruggestuurd naar dezelfde Zalo-chat.
- Standaard long-polling; webhookmodus beschikbaar met `channels.zalo.webhookUrl`.

## Beperkingen

- Uitgaande tekst wordt opgeknipt in stukken van 2000 tekens (Zalo API-limiet).
- Media-downloads/-uploads zijn begrensd door `channels.zalo.mediaMaxMb` (standaard 5).
- Streaming is standaard geblokkeerd omdat de limiet van 2000 tekens streaming minder nuttig maakt.

## Toegangsbeheer (DM's)

### DM-toegang

- Standaard: `channels.zalo.dmPolicy = "pairing"`. Onbekende afzenders ontvangen een koppelingscode; berichten worden genegeerd totdat ze zijn goedgekeurd (codes verlopen na 1 uur).
- Goedkeuren via:
  - `openclaw pairing list zalo`
  - `openclaw pairing approve zalo <CODE>`
- Koppeling is de standaard tokenuitwisseling. Details: [Pairing](/channels/pairing)
- `channels.zalo.allowFrom` accepteert numerieke gebruikers-ID's (geen gebruikersnaam-lookup beschikbaar).

## Long-polling vs webhook

- Standaard: long-polling (geen publieke URL vereist).
- Webhookmodus: stel `channels.zalo.webhookUrl` en `channels.zalo.webhookSecret` in.
  - Het webhookgeheim moet 8-256 tekens lang zijn.
  - De webhook-URL moet HTTPS gebruiken.
  - Zalo verstuurt events met de header `X-Bot-Api-Secret-Token` voor verificatie.
  - Gateway HTTP verwerkt webhookverzoeken op `channels.zalo.webhookPath` (standaard het webhook-URL-pad).

**Let op:** getUpdates (polling) en webhook zijn volgens de Zalo API-documentatie wederzijds exclusief.

## Ondersteunde berichttypen

- **Tekstberichten**: Volledige ondersteuning met chunking van 2000 tekens.
- **Afbeeldingsberichten**: Inkomende afbeeldingen downloaden en verwerken; afbeeldingen verzenden via `sendPhoto`.
- **Stickers**: Gelogd maar niet volledig verwerkt (geen agentrespons).
- **Niet-ondersteunde typen**: Gelogd (bijv. berichten van beschermde gebruikers).

## Mogelijkheden

| Functie                                 | Status                                                 |
| --------------------------------------- | ------------------------------------------------------ |
| Directe berichten                       | ✅ Ondersteund                                          |
| Groepen                                 | ❌ Binnenkort (volgens Zalo-docs)    |
| Media (afbeeldingen) | ✅ Ondersteund                                          |
| Reacties                                | ❌ Niet ondersteund                                     |
| Threads                                 | ❌ Niet ondersteund                                     |
| Polls                                   | ❌ Niet ondersteund                                     |
| Native opdrachten                       | ❌ Niet ondersteund                                     |
| Streaming                               | ⚠️ Geblokkeerd (limiet 2000 tekens) |

## Afleverdoelen (CLI/cron)

- Gebruik een chat-id als doel.
- Voorbeeld: `openclaw message send --channel zalo --target 123456789 --message "hi"`.

## Problemen oplossen

**Bot reageert niet:**

- Controleer of de token geldig is: `openclaw channels status --probe`
- Verifieer dat de afzender is goedgekeurd (koppeling of allowFrom)
- Controleer Gateway-logs: `openclaw logs --follow`

**Webhook ontvangt geen events:**

- Zorg dat de webhook-URL HTTPS gebruikt
- Verifieer dat het geheime token 8-256 tekens lang is
- Bevestig dat het Gateway HTTP-eindpunt bereikbaar is op het geconfigureerde pad
- Controleer dat getUpdates-polling niet draait (ze zijn wederzijds exclusief)

## Configuratiereferentie (Zalo)

Volledige configuratie: [Configuratie](/gateway/configuration)

Provider-opties:

- `channels.zalo.enabled`: kanaalstart in-/uitschakelen.
- `channels.zalo.botToken`: bot-token van het Zalo Bot Platform.
- `channels.zalo.tokenFile`: token lezen vanaf een bestandspad.
- `channels.zalo.dmPolicy`: `pairing | allowlist | open | disabled` (standaard: koppeling).
- `channels.zalo.allowFrom`: DM-toegestane lijst (gebruikers-ID's). `open` vereist `"*"`. De wizard vraagt om numerieke ID's.
- `channels.zalo.mediaMaxMb`: limiet voor inkomende/uitgaande media (MB, standaard 5).
- `channels.zalo.webhookUrl`: webhookmodus inschakelen (HTTPS vereist).
- `channels.zalo.webhookSecret`: webhookgeheim (8-256 tekens).
- `channels.zalo.webhookPath`: webhookpad op de Gateway HTTP-server.
- `channels.zalo.proxy`: proxy-URL voor API-verzoeken.

Opties voor meerdere accounts:

- `channels.zalo.accounts.<id>.botToken`: per-account token.
- `channels.zalo.accounts.<id>.tokenFile`: per-account tokenbestand.
- `channels.zalo.accounts.<id>.name`: weergavenaam.
- `channels.zalo.accounts.<id>.enabled`: account in-/uitschakelen.
- `channels.zalo.accounts.<id>.dmPolicy`: per-account DM-beleid.
- `channels.zalo.accounts.<id>.allowFrom`: per-account toegestane lijst.
- `channels.zalo.accounts.<id>.webhookUrl`: per-account webhook-URL.
- `channels.zalo.accounts.<id>.webhookSecret`: per-account webhookgeheim.
- `channels.zalo.accounts.<id>.webhookPath`: per-account webhookpad.
- `channels.zalo.accounts.<id>.proxy`: per-account proxy-URL.
