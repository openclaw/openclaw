---
summary: "Installatie, configuratie en gebruik van de LINE Messaging API-plugin"
read_when:
  - Je wilt OpenClaw verbinden met LINE
  - Je hebt webhook- en inloggegevens voor LINE nodig
  - Je wilt LINE-specifieke berichtopties gebruiken
title: LINE
---

# LINE (plugin)

LINE verbindt met OpenClaw via de LINE Messaging API. De plugin draait als een webhook-
ontvanger op de Gateway en gebruikt je kanaaltoegangstoken + kanaalsecret voor
authenticatie.

Status: ondersteund via plugin. Directe berichten, groepschats, media, locaties, Flex-
berichten, sjabloonberichten en snelle antwoorden worden ondersteund. Reacties en
threads worden niet ondersteund.

## Plugin vereist

Installeer de LINE-plugin:

```bash
openclaw plugins install @openclaw/line
```

Lokale checkout (bij draaien vanuit een git-repo):

```bash
openclaw plugins install ./extensions/line
```

## Installatie

1. Maak een LINE Developers-account aan en open de Console:
   [https://developers.line.biz/console/](https://developers.line.biz/console/)
2. Maak (of kies) een Provider en voeg een **Messaging API**-kanaal toe.
3. Kopieer het **Channel access token** en **Channel secret** uit de
   kanaalinstellingen.
4. Schakel **Use webhook** in bij de instellingen van de Messaging API.
5. Stel de webhook-URL in op het eindpunt van je Gateway (HTTPS vereist):

```
https://gateway-host/line/webhook
```

De Gateway reageert op LINE’s webhook-verificatie (GET) en inkomende events (POST).
Als je een aangepast pad nodig hebt, stel `channels.line.webhookPath` of
`channels.line.accounts.<id>.webhookPath` in en werk de URL dienovereenkomstig bij.

## Configureren

Minimale config:

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

Omgevingsvariabelen (alleen standaardaccount):

- `LINE_CHANNEL_ACCESS_TOKEN`
- `LINE_CHANNEL_SECRET`

Token-/secretbestanden:

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

Meerdere accounts:

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

## Toegangs beheer

Directe berichten staan standaard op koppelen. Onbekende afzenders krijgen een
koppelcode en hun berichten worden genegeerd totdat ze zijn goedgekeurd.

```bash
openclaw pairing list line
openclaw pairing approve line <CODE>
```

Toegestane lijsten en beleidsregels:

- `channels.line.dmPolicy`: `pairing | allowlist | open | disabled`
- `channels.line.allowFrom`: toegestane LINE-gebruikers-ID’s voor DM’s
- `channels.line.groupPolicy`: `allowlist | open | disabled`
- `channels.line.groupAllowFrom`: toegestane LINE-gebruikers-ID’s voor groepen
- Per-groep overrides: `channels.line.groups.<groupId>.allowFrom`

LINE-ID’s zijn hoofdlettergevoelig. Geldige ID’s zien er als volgt uit:

- Gebruiker: `U` + 32 hex-tekens
- Groep: `C` + 32 hex-tekens
- Ruimte: `R` + 32 hex-tekens

## Berichtgedrag

- Tekst wordt opgeknipt bij 5000 tekens.
- Markdown-opmaak wordt verwijderd; codeblokken en tabellen worden waar mogelijk
  omgezet naar Flex-cards.
- Streaming-antwoorden worden gebufferd; LINE ontvangt volledige chunks met een
  laadanimatie terwijl de agent werkt.
- Medi downloads zijn begrensd door `channels.line.mediaMaxMb` (standaard 10).

## Kanaaldata (rijke berichten)

Gebruik `channelData.line` om snelle antwoorden, locaties, Flex-cards of
sjabloonberichten te verzenden.

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

De LINE-plugin levert ook een `/card`-opdracht voor Flex-berichtpresets:

```
/card info "Welcome" "Thanks for joining!"
```

## Problemen oplossen

- **Webhook-verificatie mislukt:** controleer of de webhook-URL HTTPS is en of
  `channelSecret` overeenkomt met de LINE-console.
- **Geen inkomende events:** bevestig dat het webhookpad overeenkomt met
  `channels.line.webhookPath` en dat de Gateway bereikbaar is vanuit LINE.
- **Fouten bij media downloaden:** verhoog `channels.line.mediaMaxMb` als media de
  standaardlimiet overschrijdt.
