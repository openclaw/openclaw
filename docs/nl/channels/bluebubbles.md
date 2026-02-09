---
summary: "iMessage via BlueBubbles macOS-server (REST verzenden/ontvangen, typen, reacties, koppelen, geavanceerde acties)."
read_when:
  - BlueBubbles-kanaal instellen
  - Problemen oplossen met webhook-koppeling
  - iMessage configureren op macOS
title: "BlueBubbles"
---

# BlueBubbles (macOS REST)

Status: gebundelde plugin die via HTTP met de BlueBubbles macOS-server praat. **Aanbevolen voor iMessage-integratie** vanwege de rijkere API en eenvoudigere installatie vergeleken met het verouderde imsg-kanaal.

## Overzicht

- Draait op macOS via de BlueBubbles helper-app ([bluebubbles.app](https://bluebubbles.app)).
- Aanbevolen/getest: macOS Sequoia (15). macOS Tahoe (26) werkt; bewerken is momenteel kapot op Tahoe en updates van groepsiconen kunnen succes melden maar niet synchroniseren.
- OpenClaw communiceert ermee via de REST API (`GET /api/v1/ping`, `POST /message/text`, `POST /chat/:id/*`).
- Inkomende berichten komen binnen via webhooks; uitgaande antwoorden, typindicatoren, leesbevestigingen en tapbacks zijn REST-calls.
- Bijlagen en stickers worden opgenomen als inkomende media (en waar mogelijk zichtbaar gemaakt voor de agent).
- Koppelen/toegestane lijst werkt hetzelfde als bij andere kanalen (`/channels/pairing` enz.) met `channels.bluebubbles.allowFrom` + koppelcodes.
- Reacties worden weergegeven als systeemevenementen, net als bij Slack/Telegram, zodat agents ze kunnen “vermelden” vóór het antwoorden.
- Geavanceerde functies: bewerken, ongedaan maken, antwoord-threading, berichteffecten, groepsbeheer.

## Snelle start

1. Installeer de BlueBubbles-server op je Mac (volg de instructies op [bluebubbles.app/install](https://bluebubbles.app/install)).

2. Schakel in de BlueBubbles-config de web-API in en stel een wachtwoord in.

3. Voer `openclaw onboard` uit en selecteer BlueBubbles, of configureer handmatig:

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

4. Richt BlueBubbles-webhooks naar je Gateway (voorbeeld: `https://your-gateway-host:3000/bluebubbles-webhook?password=<password>`).

5. Start de Gateway; deze registreert de webhook-handler en start het koppelen.

## Messages.app actief houden (VM / headless setups)

Sommige macOS VM-/altijd-aan-setups kunnen ertoe leiden dat Messages.app “idle” wordt (inkomende gebeurtenissen stoppen totdat de app wordt geopend/naar de voorgrond gebracht). Een eenvoudige workaround is om **Messages elke 5 minuten te porren** met een AppleScript + LaunchAgent.

### 1. Sla het AppleScript op

Sla dit op als:

- `~/Scripts/poke-messages.scpt`

Voorbeeldscript (niet-interactief; steelt geen focus):

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

### 2. Installeer een LaunchAgent

Sla dit op als:

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

Notities:

- Dit draait **elke 300 seconden** en **bij inloggen**.
- De eerste run kan macOS **Automatisering**-prompts triggeren (`osascript` → Messages). Keur ze goed in dezelfde gebruikerssessie die de LaunchAgent draait.

Laad het:

```bash
launchctl unload ~/Library/LaunchAgents/com.user.poke-messages.plist 2>/dev/null || true
launchctl load ~/Library/LaunchAgents/com.user.poke-messages.plist
```

## Onboarding

BlueBubbles is beschikbaar in de interactieve installatiewizard:

```
openclaw onboard
```

De wizard vraagt om:

- **Server-URL** (vereist): adres van de BlueBubbles-server (bijv. `http://192.168.1.100:1234`)
- **Wachtwoord** (vereist): API-wachtwoord uit de BlueBubbles Server-instellingen
- **Webhook-pad** (optioneel): standaard `/bluebubbles-webhook`
- **DM-beleid**: koppelen, toegestane lijst, open of uitgeschakeld
- **Toegestane lijst**: telefoonnummers, e-mails of chatdoelen

Je kunt BlueBubbles ook via de CLI toevoegen:

```
openclaw channels add bluebubbles --http-url http://192.168.1.100:1234 --password <password>
```

## Toegangsbeheer (DM’s + groepen)

DM’s:

- Standaard: `channels.bluebubbles.dmPolicy = "pairing"`.
- Onbekende afzenders ontvangen een koppelcode; berichten worden genegeerd totdat ze zijn goedgekeurd (codes verlopen na 1 uur).
- Provideropties:
  - `openclaw pairing list bluebubbles`
  - `openclaw pairing approve bluebubbles <CODE>`
- Koppelen is de standaard tokenuitwisseling. Details: [Koppelen](/channels/pairing)

Groepen:

- `channels.bluebubbles.groupPolicy = open | allowlist | disabled` (standaard: `allowlist`).
- `channels.bluebubbles.groupAllowFrom` bepaalt wie in groepen kan triggeren wanneer `allowlist` is ingesteld.

### Mention gating (groepen)

BlueBubbles ondersteunt mention gating voor groepschats, overeenkomstig iMessage/WhatsApp-gedrag:

- Gebruikt `agents.list[].groupChat.mentionPatterns` (of `messages.groupChat.mentionPatterns`) om mentions te detecteren.
- Wanneer `requireMention` is ingeschakeld voor een groep, reageert de agent alleen wanneer deze wordt genoemd.
- Besturingsopdrachten van geautoriseerde afzenders omzeilen mention gating.

Per-groep configuratie:

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

### Command gating

- Besturingsopdrachten (bijv. `/config`, `/model`) vereisen autorisatie.
- Gebruikt `allowFrom` en `groupAllowFrom` om opdrachtautorisatie te bepalen.
- Geautoriseerde afzenders kunnen besturingsopdrachten uitvoeren, ook zonder mention in groepen.

## Typen + leesbevestigingen

- **Typindicatoren**: automatisch verzonden vóór en tijdens het genereren van het antwoord.
- **Leesbevestigingen**: geregeld via `channels.bluebubbles.sendReadReceipts` (standaard: `true`).
- **Typindicatoren**: OpenClaw verstuurt startgebeurtenissen voor typen; BlueBubbles wist typen automatisch bij verzenden of time-out (handmatig stoppen via DELETE is onbetrouwbaar).

```json5
{
  channels: {
    bluebubbles: {
      sendReadReceipts: false, // disable read receipts
    },
  },
}
```

## Geavanceerde acties

BlueBubbles ondersteunt geavanceerde berichtacties wanneer ingeschakeld in de config:

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

Beschikbare acties:

- **react**: Tapback-reacties toevoegen/verwijderen (`messageId`, `emoji`, `remove`)
- **edit**: Een verzonden bericht bewerken (`messageId`, `text`)
- **unsend**: Een bericht intrekken (`messageId`)
- **reply**: Antwoorden op een specifiek bericht (`messageId`, `text`, `to`)
- **sendWithEffect**: Verzenden met iMessage-effect (`text`, `to`, `effectId`)
- **renameGroup**: Een groepschat hernoemen (`chatGuid`, `displayName`)
- **setGroupIcon**: Het pictogram/de foto van een groepschat instellen (`chatGuid`, `media`) — onbetrouwbaar op macOS 26 Tahoe (API kan succes retourneren maar het pictogram synchroniseert niet).
- **addParticipant**: Iemand aan een groep toevoegen (`chatGuid`, `address`)
- **removeParticipant**: Iemand uit een groep verwijderen (`chatGuid`, `address`)
- **leaveGroup**: Een groepschat verlaten (`chatGuid`)
- **sendAttachment**: Media/bestanden verzenden (`to`, `buffer`, `filename`, `asVoice`)
  - Spraakmemo’s: stel `asVoice: true` in met **MP3**- of **CAF**-audio om als iMessage-spraakbericht te verzenden. BlueBubbles converteert MP3 → CAF bij het verzenden van spraakmemo’s.

### Bericht-ID’s (kort vs volledig)

OpenClaw kan _korte_ bericht-ID’s tonen (bijv. `1`, `2`) om tokens te besparen.

- `MessageSid` / `ReplyToId` kunnen korte ID’s zijn.
- `MessageSidFull` / `ReplyToIdFull` bevatten de volledige provider-ID’s.
- Korte ID’s zijn in-memory; ze kunnen verlopen bij herstart of cache-opschoning.
- Acties accepteren korte of volledige `messageId`, maar korte ID’s geven een fout als ze niet langer beschikbaar zijn.

Gebruik volledige ID’s voor duurzame automatiseringen en opslag:

- Sjablonen: `{{MessageSidFull}}`, `{{ReplyToIdFull}}`
- Context: `MessageSidFull` / `ReplyToIdFull` in inkomende payloads

Zie [Configuratie](/gateway/configuration) voor sjabloonvariabelen.

## Blokstreaming

Bepaal of antwoorden als één bericht worden verzonden of in blokken worden gestreamd:

```json5
{
  channels: {
    bluebubbles: {
      blockStreaming: true, // enable block streaming (off by default)
    },
  },
}
```

## Media + limieten

- Inkomende bijlagen worden gedownload en opgeslagen in de mediacache.
- Medialimiet via `channels.bluebubbles.mediaMaxMb` (standaard: 8 MB).
- Uitgaande tekst wordt opgeknipt tot `channels.bluebubbles.textChunkLimit` (standaard: 4000 tekens).

## Configuratie referentie

Volledige configuratie: [Configuratie](/gateway/configuration)

Provider-opties:

- `channels.bluebubbles.enabled`: Het kanaal in-/uitschakelen.
- `channels.bluebubbles.serverUrl`: Basis-URL van de BlueBubbles REST API.
- `channels.bluebubbles.password`: API-wachtwoord.
- `channels.bluebubbles.webhookPath`: Webhook-endpointpad (standaard: `/bluebubbles-webhook`).
- `channels.bluebubbles.dmPolicy`: `pairing | allowlist | open | disabled` (standaard: `pairing`).
- `channels.bluebubbles.allowFrom`: DM-toegestane lijst (handles, e-mails, E.164-nummers, `chat_id:*`, `chat_guid:*`).
- `channels.bluebubbles.groupPolicy`: `open | allowlist | disabled` (standaard: `allowlist`).
- `channels.bluebubbles.groupAllowFrom`: Toegestane lijst van groepsafzenders.
- `channels.bluebubbles.groups`: Per-groep config (`requireMention`, enz.).
- `channels.bluebubbles.sendReadReceipts`: Leesbevestigingen verzenden (standaard: `true`).
- `channels.bluebubbles.blockStreaming`: Blokstreaming inschakelen (standaard: `false`; vereist voor gestreamde antwoorden).
- `channels.bluebubbles.textChunkLimit`: Uitgaande chunkgrootte in tekens (standaard: 4000).
- `channels.bluebubbles.chunkMode`: `length` (standaard) splitst alleen bij overschrijden van `textChunkLimit`; `newline` splitst op lege regels (paragraafgrenzen) vóór lengte-opknippen.
- `channels.bluebubbles.mediaMaxMb`: Inkomende medialimiet in MB (standaard: 8).
- `channels.bluebubbles.historyLimit`: Max. aantal groepsberichten voor context (0 schakelt uit).
- `channels.bluebubbles.dmHistoryLimit`: DM-geschiedenisl limiet.
- `channels.bluebubbles.actions`: Specifieke acties in-/uitschakelen.
- `channels.bluebubbles.accounts`: Multi-accountconfiguratie.

Gerelateerde globale opties:

- `agents.list[].groupChat.mentionPatterns` (of `messages.groupChat.mentionPatterns`).
- `messages.responsePrefix`.

## Adressering / afleverdoelen

Geef de voorkeur aan `chat_guid` voor stabiele routering:

- `chat_guid:iMessage;-;+15555550123` (voorkeur voor groepen)
- `chat_id:123`
- `chat_identifier:...`
- Directe handles: `+15555550123`, `user@example.com`
  - Als een directe handle geen bestaande DM-chat heeft, maakt OpenClaw er een aan via `POST /api/v1/chat/new`. Hiervoor moet de BlueBubbles Private API zijn ingeschakeld.

## Beveiliging

- Webhook-verzoeken worden geauthenticeerd door `guid`/`password` queryparameters of headers te vergelijken met `channels.bluebubbles.password`. Verzoeken van `localhost` worden ook geaccepteerd.
- Houd het API-wachtwoord en het webhook-endpoint geheim (behandel ze als inloggegevens).
- Vertrouwen op localhost betekent dat een reverse proxy op dezelfde host onbedoeld het wachtwoord kan omzeilen. Als je de Gateway proxyt, vereis authenticatie op de proxy en configureer `gateway.trustedProxies`. Zie [Gateway-beveiliging](/gateway/security#reverse-proxy-configuration).
- Schakel HTTPS + firewallregels in op de BlueBubbles-server als je deze buiten je LAN blootstelt.

## Problemen oplossen

- Als typen-/leesgebeurtenissen stoppen met werken, controleer de BlueBubbles-webhooklogs en verifieer dat het Gateway-pad overeenkomt met `channels.bluebubbles.webhookPath`.
- Koppelcodes verlopen na één uur; gebruik `openclaw pairing list bluebubbles` en `openclaw pairing approve bluebubbles <code>`.
- Reacties vereisen de BlueBubbles private API (`POST /api/v1/message/react`); zorg dat de serverversie deze aanbiedt.
- Bewerken/ongedaan maken vereisen macOS 13+ en een compatibele BlueBubbles-serverversie. Op macOS 26 (Tahoe) is bewerken momenteel kapot door wijzigingen in de private API.
- Updates van groepsiconen kunnen onbetrouwbaar zijn op macOS 26 (Tahoe): de API kan succes retourneren maar het nieuwe pictogram synchroniseert niet.
- OpenClaw verbergt automatisch bekende defecte acties op basis van de macOS-versie van de BlueBubbles-server. Als bewerken nog steeds verschijnt op macOS 26 (Tahoe), schakel het handmatig uit met `channels.bluebubbles.actions.edit=false`.
- Voor status-/gezondheidsinfo: `openclaw status --all` of `openclaw status --deep`.

Voor algemene referentie over kanaalworkflows, zie [Kanalen](/channels) en de handleiding [Plugins](/tools/plugin).
