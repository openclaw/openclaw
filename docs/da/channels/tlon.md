---
summary: "Tlon/Urbit-supportstatus, funktioner og konfiguration"
read_when:
  - Arbejder på Tlon/Urbit-kanalfunktioner
title: "Tlon"
x-i18n:
  source_path: channels/tlon.md
  source_hash: 85fd29cda05b4563
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:49:52Z
---

# Tlon (plugin)

Tlon er en decentraliseret messenger bygget på Urbit. OpenClaw forbinder til dit Urbit-skib og kan
svare på DMs og gruppechatbeskeder. Gruppesvar kræver som standard en @-omtale og kan
yderligere begrænses via tilladelseslister.

Status: understøttet via plugin. DMs, gruppeomtaler, trådsvar og tekstbaseret medie‑fallback
(URL tilføjet til billedtekst). Reaktioner, afstemninger og native medieuploads understøttes ikke.

## Plugin påkrævet

Tlon leveres som et plugin og er ikke inkluderet i kerneinstallationen.

Installér via CLI (npm‑registry):

```bash
openclaw plugins install @openclaw/tlon
```

Lokalt checkout (ved kørsel fra et git‑repo):

```bash
openclaw plugins install ./extensions/tlon
```

Detaljer: [Plugins](/tools/plugin)

## Opsætning

1. Installér Tlon‑pluginet.
2. Indsaml din ship‑URL og login‑kode.
3. Konfigurér `channels.tlon`.
4. Genstart gatewayen.
5. Send en DM til botten eller nævn den i en gruppekanal.

Minimal konfiguration (enkelt konto):

```json5
{
  channels: {
    tlon: {
      enabled: true,
      ship: "~sampel-palnet",
      url: "https://your-ship-host",
      code: "lidlut-tabwed-pillex-ridrup",
    },
  },
}
```

## Gruppekanaler

Auto‑discovery er aktiveret som standard. Du kan også fastgøre kanaler manuelt:

```json5
{
  channels: {
    tlon: {
      groupChannels: ["chat/~host-ship/general", "chat/~host-ship/support"],
    },
  },
}
```

Deaktivér auto‑discovery:

```json5
{
  channels: {
    tlon: {
      autoDiscoverChannels: false,
    },
  },
}
```

## Adgangskontrol

DM‑tilladelsesliste (tom = tillad alle):

```json5
{
  channels: {
    tlon: {
      dmAllowlist: ["~zod", "~nec"],
    },
  },
}
```

Gruppeautorisation (begrænset som standard):

```json5
{
  channels: {
    tlon: {
      defaultAuthorizedShips: ["~zod"],
      authorization: {
        channelRules: {
          "chat/~host-ship/general": {
            mode: "restricted",
            allowedShips: ["~zod", "~nec"],
          },
          "chat/~host-ship/announcements": {
            mode: "open",
          },
        },
      },
    },
  },
}
```

## Leveringsmål (CLI/cron)

Brug disse med `openclaw message send` eller cron‑levering:

- DM: `~sampel-palnet` eller `dm/~sampel-palnet`
- Gruppe: `chat/~host-ship/channel` eller `group:~host-ship/channel`

## Noter

- Gruppesvar kræver en omtale (f.eks. `~your-bot-ship`) for at svare.
- Trådsvar: hvis den indgående besked er i en tråd, svarer OpenClaw i tråden.
- Medier: `sendMedia` falder tilbage til tekst + URL (ingen native upload).
