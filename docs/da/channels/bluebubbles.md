---
summary: "iMessage via BlueBubbles macOS-server (REST send/modtag, skrivning, reaktioner, parring, avancerede handlinger)."
read_when:
  - Opsætning af BlueBubbles-kanal
  - Fejlfinding af webhook-parring
  - Konfiguration af iMessage på macOS
title: "BlueBubbles"
---

# BlueBubbles (macOS REST)

Status: bundtet plugin, der taler med BlueBubbles macOS-serveren over HTTP. **Anbefales til iMessage integration** på grund af dens rigere API og lettere opsætning i forhold til den ældre imsg kanal.

## Overblik

- Kører på macOS via BlueBubbles-hjælpeappen ([bluebubbles.app](https://bluebubbles.app)).
- Anbefalet/testet: macOS Sequoia (15). macOS Tahoe (26) virker; redigering er i øjeblikket brudt på Tahoe, og gruppeikonopdateringer kan rapportere succes, men ikke synkronisering.
- OpenClaw kommunikerer med den via dens REST-API (`GET /api/v1/ping`, `POST /message/text`, `POST /chat/:id/*`).
- Indgående beskeder ankommer via webhooks; udgående svar, skriveindikatorer, læsekvitteringer og tapbacks er REST-kald.
- Vedhæftninger og stickers indtages som indgående medier (og vises til agenten, når det er muligt).
- Parring/tillalist virker på samme måde som andre kanaler (`/channels/pairing` etc) med `channels.bluebubbles.allowFra` + parringskoder.
- Reaktioner vises som systemhændelser ligesom Slack/Telegram, så agenter kan “nævne” dem før svar.
- Avancerede funktioner: redigér, fortryd afsendelse, svartråde, beskedeffekter, gruppeadministration.

## Hurtig start

1. Installér BlueBubbles-serveren på din Mac (følg instruktionerne på [bluebubbles.app/install](https://bluebubbles.app/install)).

2. Aktivér web-API’et i BlueBubbles-konfigurationen, og sæt en adgangskode.

3. Kør `openclaw onboard` og vælg BlueBubbles, eller konfigurér manuelt:

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

4. Peg BlueBubbles-webhooks til din gateway (eksempel: `https://your-gateway-host:3000/bluebubbles-webhook?password=<password>`).

5. Start gatewayen; den registrerer webhook-handleren og starter parring.

## Hold Messages.app i live (VM / headless-opsætninger)

Nogle macOS VM / altid-på opsætninger kan ende med Messages.app går “idle” (indkommende begivenheder stopper, indtil app'en er åbnet/foregrounded). En simpel løsning er at \*\* poke beskeder hvert 5. minut \*\* ved hjælp af en AppleScript + LaunchAgent.

### 1. Gem AppleScriptet

Gem dette som:

- `~/Scripts/poke-messages.scpt`

Eksempelscript (ikke-interaktivt; stjæler ikke fokus):

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

### 2. Installér en LaunchAgent

Gem dette som:

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

Noter:

- Dette kører **hver 300 sekunder** og **ved login**.
- Det første løb kan udløse macOS **Automation** prompts (`osascript` → Beskeder). Godkend dem i den samme brugersession, der kører LaunchAgent.

Indlæs den:

```bash
launchctl unload ~/Library/LaunchAgents/com.user.poke-messages.plist 2>/dev/null || true
launchctl load ~/Library/LaunchAgents/com.user.poke-messages.plist
```

## Introduktion

BlueBubbles er tilgængelig i den interaktive opsætningsguide:

```
openclaw onboard
```

Guiden spørger om:

- **Server URL** (påkrævet): BlueBubbles server adresse (f.eks. `http://192.168.1.100:1234`)
- **Adgangskode** (påkrævet): API-adgangskode fra BlueBubbles Server-indstillinger
- **Webhook-sti** (valgfri): Standard er `/bluebubbles-webhook`
- **DM-politik**: parring, tilladelsesliste, åben eller deaktiveret
- **Tilladelsesliste**: Telefonnumre, e-mails eller chatmål

Du kan også tilføje BlueBubbles via CLI:

```
openclaw channels add bluebubbles --http-url http://192.168.1.100:1234 --password <password>
```

## Adgangskontrol (DM’er + grupper)

DM’er:

- Standard: `channels.bluebubbles.dmPolicy = "pairing"`.
- Ukendte afsendere modtager en parringskode; beskeder ignoreres, indtil de godkendes (koder udløber efter 1 time).
- Godkend via:
  - `openclaw pairing list bluebubbles`
  - `openclaw pairing approve bluebubbles <CODE>`
- Parring er standard token udveksling. Detaljer: [Pairing](/channels/pairing)

Grupper:

- `channels.bluebubbles.groupPolicy = open | allowlist | disabled` (standard: `allowlist`).
- `channels.bluebubbles.groupAllowFrom` styrer, hvem der kan trigge i grupper, når `allowlist` er sat.

### Nævnings-gating (grupper)

BlueBubbles understøtter nævnings-gating for gruppechats, svarende til iMessage/WhatsApp-adfærd:

- Bruger `agents.list[].groupChat.mentionPatterns` (eller `messages.groupChat.mentionPatterns`) til at detektere nævninger.
- Når `requireMention` er aktiveret for en gruppe, svarer agenten kun, når den nævnes.
- Kontrolkommandoer fra autoriserede afsendere omgår nævnings-gating.

Konfiguration pr. gruppe:

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

### Kommando-gating

- Kontrolkommandoer (fx, `/config`, `/model`) kræver tilladelse.
- Bruger `allowFrom` og `groupAllowFrom` til at afgøre kommandoautorisation.
- Autoriserede afsendere kan køre kontrolkommandoer selv uden nævning i grupper.

## Skrivning + læsekvitteringer

- **Skriveindikatorer**: Sendes automatisk før og under generering af svar.
- **Læsekvitteringer**: Styres af `channels.bluebubbles.sendReadReceipts` (standard: `true`).
- **Skriveindikatorer**: OpenClaw sender typing start-hændelser; BlueBubbles rydder typing automatisk ved afsendelse eller timeout (manuel stop via DELETE er upålidelig).

```json5
{
  channels: {
    bluebubbles: {
      sendReadReceipts: false, // disable read receipts
    },
  },
}
```

## Avancerede handlinger

BlueBubbles understøtter avancerede beskedhandlinger, når de er aktiveret i konfigurationen:

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

Tilgængelige handlinger:

- **react**: Tilføj/fjern tapback-reaktioner (`messageId`, `emoji`, `remove`)
- **edit**: Redigér en sendt besked (`messageId`, `text`)
- **unsend**: Fortryd afsendelse af en besked (`messageId`)
- **reply**: Svar på en specifik besked (`messageId`, `text`, `to`)
- **sendWithEffect**: Send med iMessage-effekt (`text`, `to`, `effectId`)
- **renameGroup**: Omdøb en gruppechat (`chatGuid`, `displayName`)
- **setGroupIcon**: Sæt en gruppechats ikon/foto (`chatGuid`, `media`) — ustabilt på macOS 26 Tahoe (API’et kan returnere succes, men ikonet synkroniserer ikke).
- **addParticipant**: Tilføj en person til en gruppe (`chatGuid`, `address`)
- **removeParticipant**: Fjern en person fra en gruppe (`chatGuid`, `address`)
- **leaveGroup**: Forlad en gruppechat (`chatGuid`)
- **sendAttachment**: Send medier/filer (`to`, `buffer`, `filename`, `asVoice`)
  - Stemme memos: sæt `asVoice: true` med **MP3** eller **CAF** lyd til at sende som en iMessage stemmebesked. BlueBubbles konverterer MP3 → CAF når du sender stemme memos.

### Besked-ID’er (korte vs. fulde)

OpenClaw kan overflade _short_ besked IDs (fx, `1`, `2`) for at gemme tokens.

- `MessageSid` / `ReplyToId` kan være korte ID’er.
- `MessageSidFull` / `ReplyToIdFull` indeholder udbyderens fulde ID’er.
- Korte ID’er er i hukommelsen; de kan udløbe ved genstart eller cache-rydning.
- Handlinger accepterer korte eller fulde `messageId`, men korte ID’er vil give fejl, hvis de ikke længere er tilgængelige.

Brug fulde ID’er til holdbare automatiseringer og lagring:

- Skabeloner: `{{MessageSidFull}}`, `{{ReplyToIdFull}}`
- Kontekst: `MessageSidFull` / `ReplyToIdFull` i indgående payloads

Se [Konfiguration](/gateway/configuration) for skabelonvariabler.

## Blokstreaming

Styr om svar sendes som en enkelt besked eller streames i blokke:

```json5
{
  channels: {
    bluebubbles: {
      blockStreaming: true, // enable block streaming (off by default)
    },
  },
}
```

## Medier + grænser

- Indgående vedhæftninger downloades og gemmes i mediecachen.
- Mediegrænse via `channels.bluebubbles.mediaMaxMb` (standard: 8 MB).
- Udgående tekst opdeles i stykker på `channels.bluebubbles.textChunkLimit` (standard: 4000 tegn).

## Konfigurationsreference

Fuld konfiguration: [Konfiguration](/gateway/configuration)

Udbyderindstillinger:

- `channels.bluebubbles.enabled`: Aktivér/deaktivér kanalen.
- `channels.bluebubbles.serverUrl`: BlueBubbles REST API-base-URL.
- `channels.bluebubbles.password`: API-adgangskode.
- `channels.bluebubbles.webhookPath`: Webhook-endepunktssti (standard: `/bluebubbles-webhook`).
- `channels.bluebubbles.dmPolicy`: `pairing | allowlist | open | disabled` (standard: `pairing`).
- `channels.bluebubbles.allowFrom`: DM-tilladelsesliste (handles, e-mails, E.164-numre, `chat_id:*`, `chat_guid:*`).
- `channels.bluebubbles.groupPolicy`: `open | allowlist | disabled` (standard: `allowlist`).
- `channels.bluebubbles.groupAllowFrom`: Tilladelsesliste for gruppeafsendere.
- `channels.bluebubbles.groups`: Konfiguration pr. gruppe (`requireMention` osv.).
- `channels.bluebubbles.sendReadReceipts`: Send læsekvitteringer (standard: `true`).
- `channels.bluebubbles.blockStreaming`: Aktivér blokstreaming (standard: `false`; kræves for streamede svar).
- `channels.bluebubbles.textChunkLimit`: Udgående chunk-størrelse i tegn (standard: 4000).
- `channels.bluebubbles.chunkMode`: `length` (standard) opdeler kun ved overskridelse af `textChunkLimit`; `newline` opdeler ved tomme linjer (afsnitsgrænser) før længdeopdeling.
- `channels.bluebubbles.mediaMaxMb`: Indgående mediegrænse i MB (standard: 8).
- `channels.bluebubbles.historyLimit`: Max gruppe beskeder for kontekst (0 disables).
- `channels.bluebubbles.dmHistoryLimit`: DM-historikgrænse.
- `channels.bluebubbles.actions`: Aktivér/deaktivér specifikke handlinger.
- `channels.bluebubbles.accounts`: Konfiguration af flere konti.

Relaterede globale indstillinger:

- `agents.list[].groupChat.mentionPatterns` (eller `messages.groupChat.mentionPatterns`).
- `messages.responsePrefix`.

## Adressering / leveringsmål

Foretræk `chat_guid` for stabil routing:

- `chat_guid:iMessage;-;+15555550123` (foretrukket for grupper)
- `chat_id:123`
- `chat_identifier:...`
- Direkte handles: `+15555550123`, `user@example.com`
  - Hvis en direkte håndtag ikke har en eksisterende DM chat, vil OpenClaw oprette en via `POST /api/v1/chat/new`. Dette kræver, at BlueBubbles Privat API er aktiveret.

## Sikkerhed

- Webhook anmodninger er godkendt ved at sammenligne `guid`/`password` forespørgsel params eller headers mod `channels.bluebubbles.password`. Anmodninger fra `localhost` er også accepteret.
- Hold API-adgangskoden og webhook-endepunktet hemmelige (behandl dem som legitimationsoplysninger).
- Localhost tillid betyder en samme vært reverse proxy kan utilsigtet omgå adgangskoden. Hvis du proxy gateway, kræver auth ved proxy og konfigurere `gateway.trustedProxies`. Se [Gateway security](/gateway/security#reverse-proxy-configuration).
- Aktivér HTTPS + firewall-regler på BlueBubbles-serveren, hvis du eksponerer den uden for dit LAN.

## Fejlfinding

- Hvis skrive-/læsehændelser holder op med at virke, så tjek BlueBubbles webhook-logs og verificér, at gateway-stien matcher `channels.bluebubbles.webhookPath`.
- Parringskoder udløber efter en time; brug `openclaw pairing list bluebubbles` og `openclaw pairing approve bluebubbles <code>`.
- Reaktioner kræver BlueBubbles private API (`POST /api/v1/message/react`); sørg for, at serverversionen eksponerer den.
- Rediger/afsend kræver macOS 13+ og en kompatibel BlueBubbles-serverversion. På macOS 26 (Tahoe), redigering er i øjeblikket brudt på grund af private API ændringer.
- Opdateringer af gruppeikoner kan være ustabile på macOS 26 (Tahoe): API’et kan returnere succes, men det nye ikon synkroniserer ikke.
- OpenClaw skjuler kendte, brudte handlinger baseret på BlueBubbles-serverens macOS-version. Hvis redigering stadig vises på macOS 26 (Tahoe), deaktivere det manuelt med `channels.bluebubbles.actions.edit=false`.
- For status-/helbredsinfo: `openclaw status --all` eller `openclaw status --deep`.

For generel reference til kanalworkflow, se [Kanaler](/channels) og guiden [Plugins](/tools/plugin).
