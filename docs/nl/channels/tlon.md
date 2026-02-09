---
summary: "Ondersteuningsstatus, mogelijkheden en configuratie voor Tlon/Urbit"
read_when:
  - Werken aan Tlon/Urbit-kanaalfunctionaliteit
title: "Tlon"
---

# Tlon (plugin)

Tlon is een gedecentraliseerde messenger gebouwd op Urbit. OpenClaw maakt verbinding met je Urbit-ship en kan
reageren op DM's en groepschatberichten. Groepsantwoorden vereisen standaard een @-vermelding en kunnen
verder worden beperkt via toegestane lijsten.

Status: ondersteund via plugin. DM's, groepsvermeldingen, thread-antwoorden en een tekst-alleen media-terugval
(URL toegevoegd aan het bijschrift). Reacties, polls en native media-uploads worden niet ondersteund.

## Plugin vereist

Tlon wordt geleverd als plugin en is niet gebundeld met de kerninstallatie.

Installeren via CLI (npm-register):

```bash
openclaw plugins install @openclaw/tlon
```

Lokale checkout (bij uitvoeren vanuit een git-repo):

```bash
openclaw plugins install ./extensions/tlon
```

Details: [Plugins](/tools/plugin)

## Installatie

1. Installeer de Tlon-plugin.
2. Verzamel je ship-URL en inlogcode.
3. Configureer `channels.tlon`.
4. Herstart de Gateway.
5. Stuur een DM naar de bot of vermeld deze in een groepskanaal.

Minimale config (één account):

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

## Groepeer kanalen

Auto-discovery is standaard ingeschakeld. Je kunt kanalen ook handmatig vastpinnen:

```json5
{
  channels: {
    tlon: {
      groupChannels: ["chat/~host-ship/general", "chat/~host-ship/support"],
    },
  },
}
```

Auto-discovery uitschakelen:

```json5
{
  channels: {
    tlon: {
      autoDiscoverChannels: false,
    },
  },
}
```

## Toegangs beheer

DM-toegestane lijst (leeg = alles toestaan):

```json5
{
  channels: {
    tlon: {
      dmAllowlist: ["~zod", "~nec"],
    },
  },
}
```

Groepsautorisatie (standaard beperkt):

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

## Afleverdoelen (CLI/cron)

Gebruik deze met `openclaw message send` of cron-aflevering:

- DM: `~sampel-palnet` of `dm/~sampel-palnet`
- Groep: `chat/~host-ship/channel` of `group:~host-ship/channel`

## Notities

- Groepsantwoorden vereisen een vermelding (bijv. `~your-bot-ship`) om te reageren.
- Thread-antwoorden: als het binnenkomende bericht in een thread staat, antwoordt OpenClaw in de thread.
- Media: `sendMedia` valt terug op tekst + URL (geen native upload).
