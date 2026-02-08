---
summary: "Status for Zalo-botunderstøttelse, funktioner og konfiguration"
read_when:
  - Arbejder med Zalo-funktioner eller webhooks
title: "Zalo"
x-i18n:
  source_path: channels/zalo.md
  source_hash: bd14c0d008a23552
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:07Z
---

# Zalo (Bot API)

Status: eksperimentel. Kun direkte beskeder; grupper kommer snart ifølge Zalo-dokumentationen.

## Plugin påkrævet

Zalo leveres som et plugin og er ikke inkluderet i kerneinstallationen.

- Installér via CLI: `openclaw plugins install @openclaw/zalo`
- Eller vælg **Zalo** under introduktion og bekræft installationsprompten
- Detaljer: [Plugins](/tools/plugin)

## Hurtig opsætning (begynder)

1. Installér Zalo-pluginet:
   - Fra et source-checkout: `openclaw plugins install ./extensions/zalo`
   - Fra npm (hvis udgivet): `openclaw plugins install @openclaw/zalo`
   - Eller vælg **Zalo** under introduktion og bekræft installationsprompten
2. Sæt token:
   - Miljøvariabel: `ZALO_BOT_TOKEN=...`
   - Eller konfiguration: `channels.zalo.botToken: "..."`.
3. Genstart gateway (eller afslut introduktionen).
4. DM-adgang er parring som standard; godkend parringskoden ved første kontakt.

Minimal konfiguration:

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

## Hvad det er

Zalo er en Vietnam-fokuseret beskedapp; dens Bot API lader Gateway køre en bot til 1:1-samtaler.
Det er et godt match til support eller notifikationer, hvor du ønsker deterministisk routing tilbage til Zalo.

- En Zalo Bot API-kanal ejet af Gateway.
- Deterministisk routing: svar går tilbage til Zalo; modellen vælger aldrig kanaler.
- DM’er deler agentens hovedsession.
- Grupper understøttes endnu ikke (Zalo-dokumentationen angiver “kommer snart”).

## Opsætning (hurtig sti)

### 1) Opret et bot-token (Zalo Bot Platform)

1. Gå til [https://bot.zaloplatforms.com](https://bot.zaloplatforms.com) og log ind.
2. Opret en ny bot og konfigurer dens indstillinger.
3. Kopiér bot-tokenet (format: `12345689:abc-xyz`).

### 2) Konfigurer token (miljøvariabel eller konfiguration)

Eksempel:

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

Miljøvariabel: `ZALO_BOT_TOKEN=...` (virker kun for standardkontoen).

Understøttelse af flere konti: brug `channels.zalo.accounts` med tokens pr. konto og valgfri `name`.

3. Genstart gateway. Zalo starter, når et token findes (miljøvariabel eller konfiguration).
4. DM-adgang er som standard parring. Godkend koden, når botten kontaktes første gang.

## Sådan virker det (adfærd)

- Indgående beskeder normaliseres til den fælles kanalindpakning med mediepladsholdere.
- Svar routes altid tilbage til den samme Zalo-chat.
- Long-polling som standard; webhook-tilstand er tilgængelig med `channels.zalo.webhookUrl`.

## Begrænsninger

- Udgående tekst opdeles i bidder på 2000 tegn (Zalo API-grænse).
- Mediedownloads/-uploads er begrænset af `channels.zalo.mediaMaxMb` (standard 5).
- Streaming er blokeret som standard, da 2000-tegnsgrænsen gør streaming mindre nyttig.

## Adgangskontrol (DM’er)

### DM-adgang

- Standard: `channels.zalo.dmPolicy = "pairing"`. Ukendte afsendere modtager en parringskode; beskeder ignoreres, indtil de er godkendt (koder udløber efter 1 time).
- Godkend via:
  - `openclaw pairing list zalo`
  - `openclaw pairing approve zalo <CODE>`
- Parring er standard token-udveksling. Detaljer: [Pairing](/channels/pairing)
- `channels.zalo.allowFrom` accepterer numeriske bruger-id’er (ingen opslag af brugernavne tilgængelig).

## Long-polling vs. webhook

- Standard: long-polling (ingen offentlig URL kræves).
- Webhook-tilstand: sæt `channels.zalo.webhookUrl` og `channels.zalo.webhookSecret`.
  - Webhook-hemmeligheden skal være 8-256 tegn.
  - Webhook-URL’en skal bruge HTTPS.
  - Zalo sender events med `X-Bot-Api-Secret-Token`-header til verifikation.
  - Gateway HTTP håndterer webhook-anmodninger på `channels.zalo.webhookPath` (standard er webhook-URL’ens sti).

**Bemærk:** getUpdates (polling) og webhook er gensidigt udelukkende ifølge Zalo API-dokumentationen.

## Understøttede beskedtyper

- **Tekstbeskeder**: Fuld understøttelse med opdeling i 2000 tegn.
- **Billedbeskeder**: Download og behandl indgående billeder; send billeder via `sendPhoto`.
- **Stickers**: Logges, men behandles ikke fuldt ud (ingen agentsvar).
- **Ikke-understøttede typer**: Logges (fx beskeder fra beskyttede brugere).

## Funktioner

| Funktion          | Status                         |
| ----------------- | ------------------------------ |
| Direkte beskeder  | ✅ Understøttet                |
| Grupper           | ❌ Kommer snart (ifølge Zalo)  |
| Medier (billeder) | ✅ Understøttet                |
| Reaktioner        | ❌ Ikke understøttet           |
| Tråde             | ❌ Ikke understøttet           |
| Afstemninger      | ❌ Ikke understøttet           |
| Native kommandoer | ❌ Ikke understøttet           |
| Streaming         | ⚠️ Blokeret (2000-tegnsgrænse) |

## Leveringsmål (CLI/cron)

- Brug et chat-id som mål.
- Eksempel: `openclaw message send --channel zalo --target 123456789 --message "hi"`.

## Fejlfinding

**Botten svarer ikke:**

- Tjek at tokenet er gyldigt: `openclaw channels status --probe`
- Bekræft at afsenderen er godkendt (parring eller allowFrom)
- Tjek gateway-logs: `openclaw logs --follow`

**Webhook modtager ikke events:**

- Sørg for at webhook-URL’en bruger HTTPS
- Bekræft at den hemmelige token er 8-256 tegn
- Bekræft at gatewayens HTTP-endpoint er tilgængeligt på den konfigurerede sti
- Tjek at getUpdates-polling ikke kører (de er gensidigt udelukkende)

## Konfigurationsreference (Zalo)

Fuld konfiguration: [Konfiguration](/gateway/configuration)

Udbyderindstillinger:

- `channels.zalo.enabled`: aktivér/deaktivér opstart af kanal.
- `channels.zalo.botToken`: bot-token fra Zalo Bot Platform.
- `channels.zalo.tokenFile`: læs token fra filsti.
- `channels.zalo.dmPolicy`: `pairing | allowlist | open | disabled` (standard: parring).
- `channels.zalo.allowFrom`: DM-tilladelsesliste (bruger-id’er). `open` kræver `"*"`. Opsætningsguiden vil bede om numeriske id’er.
- `channels.zalo.mediaMaxMb`: grænse for ind-/udgående medier (MB, standard 5).
- `channels.zalo.webhookUrl`: aktivér webhook-tilstand (HTTPS kræves).
- `channels.zalo.webhookSecret`: webhook-hemmelighed (8-256 tegn).
- `channels.zalo.webhookPath`: webhook-sti på gatewayens HTTP-server.
- `channels.zalo.proxy`: proxy-URL til API-anmodninger.

Indstillinger for flere konti:

- `channels.zalo.accounts.<id>.botToken`: token pr. konto.
- `channels.zalo.accounts.<id>.tokenFile`: tokenfil pr. konto.
- `channels.zalo.accounts.<id>.name`: visningsnavn.
- `channels.zalo.accounts.<id>.enabled`: aktivér/deaktivér konto.
- `channels.zalo.accounts.<id>.dmPolicy`: DM-politik pr. konto.
- `channels.zalo.accounts.<id>.allowFrom`: tilladelsesliste pr. konto.
- `channels.zalo.accounts.<id>.webhookUrl`: webhook-URL pr. konto.
- `channels.zalo.accounts.<id>.webhookSecret`: webhook-hemmelighed pr. konto.
- `channels.zalo.accounts.<id>.webhookPath`: webhook-sti pr. konto.
- `channels.zalo.accounts.<id>.proxy`: proxy-URL pr. konto.
