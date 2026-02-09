---
summary: "Tlon/Urbit-supportstatus, funktioner og konfiguration"
read_when:
  - Arbejder på Tlon/Urbit-kanalfunktioner
title: "Tlon"
---

# Tlon (plugin)

Tlon er en decentraliseret budbringer bygget på Urbit. OpenClaw forbinder til dit Urbit skib og kan
svare på DMs og gruppe chat beskeder. Gruppens svar kræver som standard en @ omtale og kan
yderligere begrænses via tilladte lister.

Status: understøttet via plugin. DM'er, gruppe nævner, tråd svar, og tekst-kun medie fallback
(URL tilføjet til billedtekst). Reaktioner, meningsmålinger og indfødte medier uploads understøttes ikke.

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

Auto-opdagelse er aktiveret som standard. Du kan også fastgøre kanaler manuelt:

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

- Gruppens svar kræver en omtale (f.eks. `~your-bot-ship`) for at svare.
- Trådsvar: hvis den indgående besked er i en tråd, svarer OpenClaw i tråden.
- Medier: `sendMedia` falder tilbage til tekst + URL (ingen native upload).
