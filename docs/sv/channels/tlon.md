---
summary: "Supportstatus, funktioner och konfiguration för Tlon/Urbit"
read_when:
  - Arbetar med funktioner för Tlon/Urbit-kanalen
title: "Tlon"
---

# Tlon (plugin)

Tlon är en decentraliserad budbärare byggd på Urbit. OpenClaw ansluter till ditt Urbit-skepp och kan
svara på DMs och gruppchattmeddelanden. Gruppsvar kräver ett @ omnämnande som standard och kan
begränsas ytterligare via tillåtna listor.

Status: stöds via plugin. DMs, gruppomnämnanden, trådsvar och endast text-media fallback
(URL läggs till bildtext). Reaktioner, opinionsundersökningar och infödda medieuppladdningar stöds inte.

## Plugin krävs

Tlon levereras som ett plugin och ingår inte i kärninstallationen.

Installera via CLI (npm-registret):

```bash
openclaw plugins install @openclaw/tlon
```

Lokal utcheckning (vid körning från ett git-repo):

```bash
openclaw plugins install ./extensions/tlon
```

Detaljer: [Plugins](/tools/plugin)

## Konfigurering

1. Installera Tlon-pluginet.
2. Samla in din skepp-URL och inloggningskod.
3. Konfigurera `channels.tlon`.
4. Starta om gatewayn.
5. Skicka ett DM till boten eller nämn den i en gruppkanal.

Minimal konfig (ett konto):

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

## Gruppkanaler

Auto-upptäckten är aktiverad som standard. Du kan också fästa kanaler manuellt:

```json5
{
  channels: {
    tlon: {
      groupChannels: ["chat/~host-ship/general", "chat/~host-ship/support"],
    },
  },
}
```

Inaktivera automatisk Discovery (upptäckt):

```json5
{
  channels: {
    tlon: {
      autoDiscoverChannels: false,
    },
  },
}
```

## Åtkomstkontroll

DM-tillåtelselista (tom = tillåt alla):

```json5
{
  channels: {
    tlon: {
      dmAllowlist: ["~zod", "~nec"],
    },
  },
}
```

Gruppauktorisering (begränsad som standard):

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

## Leveransmål (CLI/cron)

Använd dessa med `openclaw message send` eller cron-leverans:

- DM: `~sampel-palnet` eller `dm/~sampel-palnet`
- Grupp: `chat/~host-ship/channel` eller `group:~host-ship/channel`

## Noteringar

- Gruppsvar kräver ett omnämnande (t.ex. `~your-bot-ship`) för att svara.
- Trådsvar: om inkommande meddelande är i en tråd svarar OpenClaw i tråden.
- Media: `sendMedia` faller tillbaka till text + URL (ingen inbyggd uppladdning).
