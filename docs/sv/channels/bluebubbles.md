---
summary: "iMessage via BlueBubbles macOS-server (REST sänd/motta, skrivindikatorer, reaktioner, parning, avancerade åtgärder)."
read_when:
  - Konfigurera BlueBubbles-kanalen
  - Felsökning av webhook-parning
  - Konfigurera iMessage på macOS
title: "BlueBubbles"
---

# BlueBubbles (macOS REST)

Status: buntade plugin som talar till BlueBubbles macOS server över HTTP. **Rekommenderas för iMessage integration** på grund av dess rikare API och enklare installation jämfört med äldre imsg kanal.

## Översikt

- Körs på macOS via BlueBubbles hjälpapplikation ([bluebubbles.app](https://bluebubbles.app)).
- Rekommenderad/testad: macOS Sequoia (15). macOS Tahoe (26) fungerar; redigering är för närvarande trasigt på Tahoe, och gruppikonuppdateringar kan rapportera framgång men inte synkronisera.
- OpenClaw pratar med den via dess REST‑API (`GET /api/v1/ping`, `POST /message/text`, `POST /chat/:id/*`).
- Inkommande meddelanden levereras via webhooks; utgående svar, skrivindikatorer, läskvitton och tapbacks är REST‑anrop.
- Bilagor och stickers tas emot som inkommande media (och exponeras för agenten när möjligt).
- Parning/tillåtelselista fungerar på samma sätt som andra kanaler (`/channels/pairing` etc) med `channels.bluebubbles.allowFrom` + parningskoder.
- Reaktioner exponeras som systemhändelser precis som i Slack/Telegram så att agenter kan ”nämna” dem innan de svarar.
- Avancerade funktioner: redigera, ångra sändning, svarstrådar, meddelandeeffekter, grupphantering.

## Snabbstart

1. Installera BlueBubbles‑servern på din Mac (följ instruktionerna på [bluebubbles.app/install](https://bluebubbles.app/install)).

2. I BlueBubbles‑konfigen, aktivera webb‑API:t och ange ett lösenord.

3. Kör `openclaw onboard` och välj BlueBubbles, eller konfigurera manuellt:

   ```json5
   {
     channels: {
       bluebubbles: {
         enabled: true,
         serverUrl: "http://192.168.1.100:1234",
         password: "example-password",
         webhookPath: "/bluebubbles-webhook",
       },
     },
   }
   ```

4. Peka BlueBubbles webhooks till din gateway (exempel: `https://your-gateway-host:3000/bluebubbles-webhook?password=<password>`).

5. Starta gatewayen; den registrerar webhook‑hanteraren och påbörjar parning.

## Hålla Messages.app vid liv (VM / headless‑miljöer)

Vissa macOS VM / alltid-på-inställningar kan sluta med Messages.app som går “inaktiv” (inkommande händelser slutar tills appen är öppen/föregrundad). En enkel lösning är att **peta meddelanden var femte minuter** med hjälp av ett AppleScript + LaunchAgent.

### 1. Spara AppleScriptet

Spara detta som:

- `~/Scripts/poke-messages.scpt`

Exempelskript (icke‑interaktivt; tar inte fokus):

```applescript
try
  tell application "Messages"
    if not running then
      launch
    end if

    -- Touch the scripting interface to keep the process responsive.
    set _chatCount to (count of chats)
  end tell
on error
  -- Ignore transient failures (first-run prompts, locked session, etc).
end try
```

### 2. Installera en LaunchAgent

Spara detta som:

- `~/Library/LaunchAgents/com.user.poke-messages.plist`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>com.user.poke-messages</string>

    <key>ProgramArguments</key>
    <array>
      <string>/bin/bash</string>
      <string>-lc</string>
      <string>/usr/bin/osascript &quot;$HOME/Scripts/poke-messages.scpt&quot;</string>
    </array>

    <key>RunAtLoad</key>
    <true/>

    <key>StartInterval</key>
    <integer>300</integer>

    <key>StandardOutPath</key>
    <string>/tmp/poke-messages.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/poke-messages.err</string>
  </dict>
</plist>
```

Noteringar:

- Detta körs **var 300:e sekund** och **vid inloggning**.
- Den första körningen kan utlösa macOS **Automation** uppmaningar (`osascript` → Meddelanden). Godkänn dem i samma användarsession som driver LaunchAgent.

Ladda den:

```bash
launchctl unload ~/Library/LaunchAgents/com.user.poke-messages.plist 2>/dev/null || true
launchctl load ~/Library/LaunchAgents/com.user.poke-messages.plist
```

## Introduktion

BlueBubbles finns tillgänglig i den interaktiva installationsguiden:

```
openclaw onboard
```

Guiden frågar efter:

- **Server URL** (obligatoriskt): BlueBubbles serveradress (t.ex., `http://192.168.1.100:1234`)
- **Lösenord** (krävs): API‑lösenord från BlueBubbles Server‑inställningar
- **Webhook‑sökväg** (valfritt): Standard är `/bluebubbles-webhook`
- **DM‑policy**: parning, tillåtelselista, öppen eller inaktiverad
- **Tillåtelselista**: Telefonnummer, e‑postadresser eller chattmål

Du kan även lägga till BlueBubbles via CLI:

```
openclaw channels add bluebubbles --http-url http://192.168.1.100:1234 --password <password>
```

## Åtkomstkontroll (DM + grupper)

DM:

- Standard: `channels.bluebubbles.dmPolicy = "pairing"`.
- Okända avsändare får en parningskod; meddelanden ignoreras tills de godkänns (koder löper ut efter 1 timme).
- Godkänn via:
  - `openclaw pairing list bluebubbles`
  - `openclaw pairing approve bluebubbles <CODE>`
- Parkoppling är standard token exchange. Detaljer: [Pairing](/channels/pairing)

Grupper:

- `channels.bluebubbles.groupPolicy = open | allowlist | disabled` (standard: `allowlist`).
- `channels.bluebubbles.groupAllowFrom` styr vem som kan trigga i grupper när `allowlist` är satt.

### Nämningsgrind (grupper)

BlueBubbles stöder nämningsgrind för gruppchattar, i linje med iMessage/WhatsApp‑beteende:

- Använder `agents.list[].groupChat.mentionPatterns` (eller `messages.groupChat.mentionPatterns`) för att upptäcka nämningar.
- När `requireMention` är aktiverad för en grupp svarar agenten endast när den nämns.
- Kontrollkommandon från behöriga avsändare kringgår nämningsgrinden.

Konfiguration per grupp:

```json5
{
  channels: {
    bluebubbles: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15555550123"],
      groups: {
        "*": { requireMention: true }, // default for all groups
        "iMessage;-;chat123": { requireMention: false }, // override for specific group
      },
    },
  },
}
```

### Kommandogrind

- Kontrollkommandon (t.ex., `/config`, `/model`) kräver auktorisering.
- Använder `allowFrom` och `groupAllowFrom` för att avgöra kommandobehörighet.
- Behöriga avsändare kan köra kontrollkommandon även utan att nämna i grupper.

## Skrivindikatorer + läskvitton

- **Skrivindikatorer**: Skickas automatiskt före och under svarsgenerering.
- **Läskvitton**: Styrs av `channels.bluebubbles.sendReadReceipts` (standard: `true`).
- **Skrivindikatorer**: OpenClaw skickar start‑händelser; BlueBubbles rensar skrivstatus automatiskt vid sändning eller timeout (manuell stopp via DELETE är opålitlig).

```json5
{
  channels: {
    bluebubbles: {
      sendReadReceipts: false, // disable read receipts
    },
  },
}
```

## Avancerade åtgärder

BlueBubbles stöder avancerade meddelandeåtgärder när de är aktiverade i konfigen:

```json5
{
  channels: {
    bluebubbles: {
      actions: {
        reactions: true, // tapbacks (default: true)
        edit: true, // edit sent messages (macOS 13+, broken on macOS 26 Tahoe)
        unsend: true, // unsend messages (macOS 13+)
        reply: true, // reply threading by message GUID
        sendWithEffect: true, // message effects (slam, loud, etc.)
        renameGroup: true, // rename group chats
        setGroupIcon: true, // set group chat icon/photo (flaky on macOS 26 Tahoe)
        addParticipant: true, // add participants to groups
        removeParticipant: true, // remove participants from groups
        leaveGroup: true, // leave group chats
        sendAttachment: true, // send attachments/media
      },
    },
  },
}
```

Tillgängliga åtgärder:

- **react**: Lägg till/ta bort tapback‑reaktioner (`messageId`, `emoji`, `remove`)
- **edit**: Redigera ett skickat meddelande (`messageId`, `text`)
- **unsend**: Ångra sändning av ett meddelande (`messageId`)
- **reply**: Svara på ett specifikt meddelande (`messageId`, `text`, `to`)
- **sendWithEffect**: Skicka med iMessage‑effekt (`text`, `to`, `effectId`)
- **renameGroup**: Byt namn på en gruppchatt (`chatGuid`, `displayName`)
- **setGroupIcon**: Sätt ikon/foto för en gruppchatt (`chatGuid`, `media`) — opålitligt på macOS 26 Tahoe (API:t kan rapportera lyckat men ikonen synkroniseras inte).
- **addParticipant**: Lägg till någon i en grupp (`chatGuid`, `address`)
- **removeParticipant**: Ta bort någon från en grupp (`chatGuid`, `address`)
- **leaveGroup**: Lämna en gruppchatt (`chatGuid`)
- **sendAttachment**: Skicka media/filer (`to`, `buffer`, `filename`, `asVoice`)
  - Röstmemos: sätt `asVoice: true` med **MP3** eller **CAF** ljud att skicka som ett iMessage röstmeddelande. BlueBubbles konverterar MP3 → CAF när du skickar röstmemos.

### Meddelande‑ID:n (korta vs fullständiga)

OpenClaw kan ytbehandla _short_ meddelande ID (t.ex., `1`, `2`) för att spara tokens.

- `MessageSid` / `ReplyToId` kan vara korta ID:n.
- `MessageSidFull` / `ReplyToIdFull` innehåller leverantörens fullständiga ID:n.
- Korta ID:n är in‑memory; de kan löpa ut vid omstart eller cache‑rensning.
- Åtgärder accepterar korta eller fullständiga `messageId`, men korta ID:n ger fel om de inte längre finns.

Använd fullständiga ID:n för hållbara automationer och lagring:

- Mallar: `{{MessageSidFull}}`, `{{ReplyToIdFull}}`
- Kontext: `MessageSidFull` / `ReplyToIdFull` i inkommande payloads

Se [Konfiguration](/gateway/configuration) för mallvariabler.

## Blockstreaming

Styr om svar skickas som ett enda meddelande eller strömmas i block:

```json5
{
  channels: {
    bluebubbles: {
      blockStreaming: true, // enable block streaming (off by default)
    },
  },
}
```

## Media + gränser

- Inkommande bilagor laddas ned och lagras i mediacachen.
- Mediatak via `channels.bluebubbles.mediaMaxMb` (standard: 8 MB).
- Utgående text delas upp till `channels.bluebubbles.textChunkLimit` (standard: 4000 tecken).

## Konfigurationsreferens

Fullständig konfiguration: [Konfiguration](/gateway/configuration)

Leverantörsalternativ:

- `channels.bluebubbles.enabled`: Aktivera/inaktivera kanalen.
- `channels.bluebubbles.serverUrl`: Bas‑URL för BlueBubbles REST‑API.
- `channels.bluebubbles.password`: API‑lösenord.
- `channels.bluebubbles.webhookPath`: Webhook‑endpoint‑sökväg (standard: `/bluebubbles-webhook`).
- `channels.bluebubbles.dmPolicy`: `pairing | allowlist | open | disabled` (standard: `pairing`).
- `channels.bluebubbles.allowFrom`: DM‑tillåtelselista (handles, e‑post, E.164‑nummer, `chat_id:*`, `chat_guid:*`).
- `channels.bluebubbles.groupPolicy`: `open | allowlist | disabled` (standard: `allowlist`).
- `channels.bluebubbles.groupAllowFrom`: Tillåtelselista för gruppavsändare.
- `channels.bluebubbles.groups`: Per‑grupp‑konfig (`requireMention`, etc.).
- `channels.bluebubbles.sendReadReceipts`: Skicka läskvitton (standard: `true`).
- `channels.bluebubbles.blockStreaming`: Aktivera blockstreaming (standard: `false`; krävs för strömmande svar).
- `channels.bluebubbles.textChunkLimit`: Utgående chunk‑storlek i tecken (standard: 4000).
- `channels.bluebubbles.chunkMode`: `length` (standard) delar endast när `textChunkLimit` överskrids; `newline` delar på tomrader (styckegränser) före längddelning.
- `channels.bluebubbles.mediaMaxMb`: Tak för inkommande media i MB (standard: 8).
- `channels.bluebubbles.historyLimit`: Max gruppmeddelanden för kontext (0 inaktiverar).
- `channels.bluebubbles.dmHistoryLimit`: DM‑historikgräns.
- `channels.bluebubbles.actions`: Aktivera/inaktivera specifika åtgärder.
- `channels.bluebubbles.accounts`: Konfiguration för flera konton.

Relaterade globala alternativ:

- `agents.list[].groupChat.mentionPatterns` (eller `messages.groupChat.mentionPatterns`).
- `messages.responsePrefix`.

## Adressering / leveransmål

Föredra `chat_guid` för stabil routning:

- `chat_guid:iMessage;-;+15555550123` (föredras för grupper)
- `chat_id:123`
- `chat_identifier:...`
- Direkta handles: `+15555550123`, `user@example.com`
  - Om ett direkt handtag inte har en befintlig DM-chatt kommer OpenClaw att skapa en via `POST /api/v1/chat/new`. Detta kräver att BlueBubbles Private API aktiveras.

## Säkerhet

- Webhook förfrågningar autentiseras genom att jämföra `guid`/`password` frågeparametrar eller rubriker mot `channels.bluebubbles.password`. Förfrågningar från `localhost` accepteras också.
- Håll API‑lösenordet och webhook‑endpointen hemliga (behandla dem som inloggningsuppgifter).
- Localhost förtroende innebär att en omvänd proxy oavsiktligt kan kringgå lösenordet. Om du proxy gateway, behöver auth på proxy och konfigurera `gateway.trustedProxies`. Se [Gateway security](/gateway/security#reverse-proxy-configuration).
- Aktivera HTTPS + brandväggsregler på BlueBubbles‑servern om du exponerar den utanför ditt LAN.

## Felsökning

- Om skriv-/läs‑händelser slutar fungera, kontrollera BlueBubbles webhook‑loggar och verifiera att gateway‑sökvägen matchar `channels.bluebubbles.webhookPath`.
- Parningskoder löper ut efter en timme; använd `openclaw pairing list bluebubbles` och `openclaw pairing approve bluebubbles <code>`.
- Reaktioner kräver BlueBubbles Private API (`POST /api/v1/message/react`); säkerställ att serverversionen exponerar det.
- Redigera/avsända kräver macOS 13+ och en kompatibel BlueBubbles serverversion. På macOS 26 (Tahoe) bryts redigeringen för närvarande på grund av privata API-ändringar.
- Uppdateringar av gruppikoner kan vara opålitliga på macOS 26 (Tahoe): API:t kan rapportera lyckat men den nya ikonen synkroniseras inte.
- OpenClaw auto-gömmer kända-trasiga åtgärder baserade på BlueBubbles serverns macOS version. Om redigering fortfarande visas på macOS 26 (Tahoe), inaktivera den manuellt med `channels.bluebubbles.actions.edit=false`.
- För status-/hälsoinformation: `openclaw status --all` eller `openclaw status --deep`.

För allmän referens om kanalflöden, se [Kanaler](/channels) och guiden [Plugins](/tools/plugin).
