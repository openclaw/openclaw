---
summary: "Opsætning, konfiguration og brug af LINE Messaging API-plugin"
read_when:
  - Du vil forbinde OpenClaw til LINE
  - Du har brug for opsætning af LINE webhook og legitimationsoplysninger
  - Du vil bruge LINE-specifikke beskedindstillinger
title: LINE
---

# LINE (plugin)

LINE forbinder til OpenClaw via LINE Messaging API. Plugin kører som en webhook
modtager på gatewayen og bruger din kanal adgangstoken + kanal hemmelighed til
godkendelse.

Status: understøttet via plugin. Direkte beskeder, gruppechats, medier, placeringer, Flex
beskeder, skabelonbeskeder og hurtige svar understøttes. Reaktioner og tråde
understøttes ikke.

## Plugin påkrævet

Installér LINE‑plugin’et:

```bash
openclaw plugins install @openclaw/line
```

Lokalt checkout (når der køres fra et git‑repo):

```bash
openclaw plugins install ./extensions/line
```

## Opsætning

1. Opret en LINE Developers‑konto, og åbn Console:
   [https://developers.line.biz/console/](https://developers.line.biz/console/)
2. Opret (eller vælg) en Provider, og tilføj en **Messaging API**‑kanal.
3. Kopiér **Channel access token** og **Channel secret** fra kanalindstillingerne.
4. Aktivér **Use webhook** i Messaging API‑indstillingerne.
5. Sæt webhook‑URL’en til dit gateway‑endpoint (HTTPS påkrævet):

```
https://gateway-host/line/webhook
```

Gatewayen reagerer på LINE’s webhook verifikation (GET) og indgående begivenheder (POST).
Hvis du har brug for en brugerdefineret sti, sæt `channels.line.webhookPath` eller
`channels.line.accounts.<id>.webhookPath` og opdatere URL'en i overensstemmelse hermed.

## Konfiguration

Minimal konfiguration:

```json5
{
  channels: {
    line: {
      enabled: true,
      channelAccessToken: "LINE_CHANNEL_ACCESS_TOKEN",
      channelSecret: "LINE_CHANNEL_SECRET",
      dmPolicy: "pairing",
    },
  },
}
```

Miljøvariabler (kun standardkonto):

- `LINE_CHANNEL_ACCESS_TOKEN`
- `LINE_CHANNEL_SECRET`

Token/secret‑filer:

```json5
{
  channels: {
    line: {
      tokenFile: "/path/to/line-token.txt",
      secretFile: "/path/to/line-secret.txt",
    },
  },
}
```

Flere konti:

```json5
{
  channels: {
    line: {
      accounts: {
        marketing: {
          channelAccessToken: "...",
          channelSecret: "...",
          webhookPath: "/line/marketing",
        },
      },
    },
  },
}
```

## Adgangskontrol

Direkte beskeder standard til parring. Ukendte afsendere får en parringskode, og deres
beskeder ignoreres indtil de er godkendt.

```bash
openclaw pairing list line
openclaw pairing approve line <CODE>
```

Tilladelseslister og politikker:

- `channels.line.dmPolicy`: `pairing | allowlist | open | disabled`
- `channels.line.allowFrom`: tilladelseslistede LINE‑bruger‑ID’er for DMs
- `channels.line.groupPolicy`: `allowlist | open | disabled`
- `channels.line.groupAllowFrom`: tilladelseslistede LINE‑bruger‑ID’er for grupper
- Per-gruppe tilsidesættelser: `channels.line.groups.<groupId>.allowFrom`

LINE-ID'er er versalfølsomme. Gyldige ID'er ser ud:

- Bruger: `U` + 32 hex‑tegn
- Gruppe: `C` + 32 hex‑tegn
- Rum: `R` + 32 hex‑tegn

## Beskedadfærd

- Tekst opdeles i bidder på 5000 tegn.
- Markdown‑formatering fjernes; kodeblokke og tabeller konverteres til Flex‑
  kort, når det er muligt.
- Streaming‑svar bufferes; LINE modtager fulde bidder med en indlæsnings‑
  animation, mens agenten arbejder.
- Mediedownloads begrænses af `channels.line.mediaMaxMb` (standard 10).

## Kanaldata (rige beskeder)

Brug `channelData.line` til at sende hurtige svar, lokationer, Flex‑kort eller
skabelonbeskeder.

```json5
{
  text: "Here you go",
  channelData: {
    line: {
      quickReplies: ["Status", "Help"],
      location: {
        title: "Office",
        address: "123 Main St",
        latitude: 35.681236,
        longitude: 139.767125,
      },
      flexMessage: {
        altText: "Status card",
        contents: {
          /* Flex payload */
        },
      },
      templateMessage: {
        type: "confirm",
        text: "Proceed?",
        confirmLabel: "Yes",
        confirmData: "yes",
        cancelLabel: "No",
        cancelData: "no",
      },
    },
  },
}
```

LINE‑plugin’et leveres også med en `/card`‑kommando til Flex‑
beskedforudindstillinger:

```
/card info "Welcome" "Thanks for joining!"
```

## Fejlfinding

- **Webhook‑verifikation fejler:** sørg for, at webhook‑URL’en er HTTPS, og at
  `channelSecret` matcher LINE‑konsollen.
- **Ingen indgående hændelser:** bekræft, at webhook‑stien matcher `channels.line.webhookPath`,
  og at gatewayen er tilgængelig fra LINE.
- **Fejl ved mediedownload:** hæv `channels.line.mediaMaxMb`, hvis medier overstiger
  standardgrænsen.
