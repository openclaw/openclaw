---
summary: "Konfiguration, inställningar och användning av LINE Messaging API-plugin"
read_when:
  - Du vill ansluta OpenClaw till LINE
  - Du behöver konfigurera LINE-webhook + autentiseringsuppgifter
  - Du vill använda LINE-specifika meddelandealternativ
title: LINE
---

# LINE (plugin)

LINE ansluter till OpenClaw via LINE Messaging API. Pluginen körs som en webhook
mottagare på gateway och använder din kanal åtkomsttoken + kanal hemlighet för
autentisering.

Status: stöds via plugin. Direktmeddelanden, gruppchattar, media, platser, Flex
meddelanden, mallmeddelanden och snabba svar stöds. Reaktioner och trådar
stöds inte.

## Plugin krävs

Installera LINE‑pluginen:

```bash
openclaw plugins install @openclaw/line
```

Lokal utcheckning (vid körning från ett git‑repo):

```bash
openclaw plugins install ./extensions/line
```

## Konfigurering

1. Skapa ett LINE Developers‑konto och öppna konsolen:
   [https://developers.line.biz/console/](https://developers.line.biz/console/)
2. Skapa (eller välj) en Provider och lägg till en **Messaging API**‑kanal.
3. Kopiera **Channel access token** och **Channel secret** från kanalinställningarna.
4. Aktivera **Use webhook** i inställningarna för Messaging API.
5. Ställ in webhook‑URL:en till din gateway‑endpoint (HTTPS krävs):

```
https://gateway-host/line/webhook
```

Gateway svarar på LINE: s webhook verifiering (GET) och inkommande händelser (POST).
Om du behöver en anpassad sökväg, ange `channels.line.webhookPath` eller
`channels.line.accounts.<id>.webhookPath` och uppdatera URL därefter.

## Konfiguration

Minimal konfig:

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

Miljövariabler (endast standardkonto):

- `LINE_CHANNEL_ACCESS_TOKEN`
- `LINE_CHANNEL_SECRET`

Token-/hemlighetsfiler:

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

Flera konton:

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

## Åtkomstkontroll

Direktmeddelanden standard att para ihop. Okända avsändare får en parningskod och deras
-meddelanden ignoreras tills de godkänts.

```bash
openclaw pairing list line
openclaw pairing approve line <CODE>
```

Tillåtelselistor och policyer:

- `channels.line.dmPolicy`: `pairing | allowlist | open | disabled`
- `channels.line.allowFrom`: tillåtelselista med LINE‑användar‑ID:n för DM
- `channels.line.groupPolicy`: `allowlist | open | disabled`
- `channels.line.groupAllowFrom`: tillåtelselista med LINE‑användar‑ID:n för grupper
- Åsidosätter per grupp: `channels.line.groups.<groupId>.allowFrom`

LINE-ID är skiftlägeskänsliga. Giltiga ID ser ut som:

- Användare: `U` + 32 hex‑tecken
- Grupp: `C` + 32 hex‑tecken
- Rum: `R` + 32 hex‑tecken

## Meddelandebeteende

- Text delas upp i segment om 5000 tecken.
- Markdown‑formatering tas bort; kodblock och tabeller konverteras till Flex‑
  kort när det är möjligt.
- Strömmande svar buffras; LINE tar emot hela segment med en laddnings‑
  animation medan agenten arbetar.
- Nedladdning av media begränsas av `channels.line.mediaMaxMb` (standard 10).

## Kanaldata (rika meddelanden)

Använd `channelData.line` för att skicka snabbsvar, platser, Flex‑kort eller
mallmeddelanden.

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

LINE‑pluginen levereras även med ett `/card`‑kommando för
förinställningar av Flex‑meddelanden:

```
/card info "Welcome" "Thanks for joining!"
```

## Felsökning

- **Webhook‑verifiering misslyckas:** säkerställ att webhook‑URL:en är HTTPS och
  att `channelSecret` matchar LINE‑konsolen.
- **Inga inkommande händelser:** bekräfta att webhook‑sökvägen matchar
  `channels.line.webhookPath` och att gatewayen är nåbar från LINE.
- **Fel vid nedladdning av media:** höj `channels.line.mediaMaxMb` om media överskrider
  standardgränsen.
