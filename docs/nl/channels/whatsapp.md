---
summary: "WhatsApp (webkanaal) integratie: inloggen, inbox, antwoorden, media en beheer"
read_when:
  - Werken aan gedrag van het WhatsApp/webkanaal of inboxroutering
title: "WhatsApp"
---

# WhatsApp (webkanaal)

Status: Alleen WhatsApp Web via Baileys. De Gateway beheert de sessie(s).

## Snelle installatie (beginner)

1. Gebruik indien mogelijk een **apart telefoonnummer** (aanbevolen).
2. Configureer WhatsApp in `~/.openclaw/openclaw.json`.
3. Voer `openclaw channels login` uit om de QR-code te scannen (Gekoppelde apparaten).
4. Start de Gateway.

Minimale config:

```json5
{
  channels: {
    whatsapp: {
      dmPolicy: "allowlist",
      allowFrom: ["+15551234567"],
    },
  },
}
```

## Doelen

- Meerdere WhatsApp-accounts (multi-account) in één Gateway-proces.
- Deterministische routering: antwoorden gaan terug naar WhatsApp, geen modelroutering.
- Het model ziet voldoende context om geciteerde antwoorden te begrijpen.

## Config-wegschrijvingen

Standaard mag WhatsApp config-updates wegschrijven die worden getriggerd door `/config set|unset` (vereist `commands.config: true`).

Uitschakelen met:

```json5
{
  channels: { whatsapp: { configWrites: false } },
}
```

## Architectuur (wie beheert wat)

- **Gateway** beheert de Baileys-socket en de inbox-lus.
- **CLI / macOS-app** communiceren met de gateway; geen direct Baileys-gebruik.
- **Actieve listener** is vereist voor uitgaande verzendingen; anders faalt verzenden direct.

## Een telefoonnummer verkrijgen (twee modi)

WhatsApp vereist een echt mobiel nummer voor verificatie. VoIP- en virtuele nummers worden meestal geblokkeerd. Er zijn twee ondersteunde manieren om OpenClaw met WhatsApp te gebruiken:

### Dedicated nummer (aanbevolen)

Gebruik een **apart telefoonnummer** voor OpenClaw. Beste UX, schone routering, geen eigenaardigheden met zelf-chats. Ideale setup: **reserve/oude Android-telefoon + eSIM**. Laat deze op Wi‑Fi en stroom staan en koppel via QR.

**WhatsApp Business:** Je kunt WhatsApp Business op hetzelfde apparaat gebruiken met een ander nummer. Handig om je persoonlijke WhatsApp gescheiden te houden — installeer WhatsApp Business en registreer daar het OpenClaw-nummer.

**Voorbeeldconfig (dedicated nummer, single-user toegestane lijst):**

```json5
{
  channels: {
    whatsapp: {
      dmPolicy: "allowlist",
      allowFrom: ["+15551234567"],
    },
  },
}
```

**Koppelmodus (optioneel):**
Als je koppelen wilt in plaats van een toegestane lijst, stel `channels.whatsapp.dmPolicy` in op `pairing`. Onbekende afzenders krijgen een koppelcode; goedkeuren met:
`openclaw pairing approve whatsapp <code>`

### Persoonlijk nummer (fallback)

Snelle fallback: draai OpenClaw op **je eigen nummer**. Stuur jezelf berichten (WhatsApp “Bericht aan jezelf”) om te testen zodat je geen contacten spamt. Verwacht tijdens installatie en experimenten verificatiecodes op je hoofdtelefoon te lezen. **Zelf-chatmodus moet ingeschakeld zijn.**
Wanneer de wizard om je persoonlijke WhatsApp-nummer vraagt, voer het nummer in waarvan je berichten stuurt (de eigenaar/afzender), niet het assistentnummer.

**Voorbeeldconfig (persoonlijk nummer, zelf-chat):**

```json
{
  "whatsapp": {
    "selfChatMode": true,
    "dmPolicy": "allowlist",
    "allowFrom": ["+15551234567"]
  }
}
```

Zelf-chatantwoorden gebruiken standaard `[{identity.name}]` wanneer ingesteld (anders `[openclaw]`)
als `messages.responsePrefix` niet is ingesteld. Stel dit expliciet in om het
voorvoegsel aan te passen of uit te schakelen (gebruik `""` om het te verwijderen).

### Tips voor nummerbron

- **Lokale eSIM** van je nationale mobiele provider (meest betrouwbaar)
  - Oostenrijk: [hot.at](https://www.hot.at)
  - VK: [giffgaff](https://www.giffgaff.com) — gratis SIM, geen contract
- **Prepaid SIM** — goedkoop; hoeft slechts één SMS voor verificatie te ontvangen

**Vermijd:** TextNow, Google Voice, de meeste “gratis SMS”-diensten — WhatsApp blokkeert deze agressief.

**Tip:** Het nummer hoeft slechts één verificatie-SMS te ontvangen. Daarna blijven WhatsApp Web-sessies bestaan via `creds.json`.

## Waarom geen Twilio?

- Vroege OpenClaw-builds ondersteunden Twilio’s WhatsApp Business-integratie.
- WhatsApp Business-nummers passen slecht bij een persoonlijke assistent.
- Meta handhaaft een antwoordvenster van 24 uur; als je de afgelopen 24 uur niet hebt gereageerd, kan het business-nummer geen nieuwe berichten initiëren.
- Hoog volume of “chatty” gebruik triggert agressieve blokkades, omdat business-accounts niet bedoeld zijn om tientallen persoonlijke assistentberichten te versturen.
- Resultaat: onbetrouwbare aflevering en frequente blokkades; daarom is ondersteuning verwijderd.

## Inloggen + referenties

- Inlogopdracht: `openclaw channels login` (QR via Gekoppelde apparaten).
- Multi-account inloggen: `openclaw channels login --account <id>` (`<id>` = `accountId`).
- Standaardaccount (wanneer `--account` is weggelaten): `default` indien aanwezig, anders het eerste geconfigureerde account-id (gesorteerd).
- Referenties opgeslagen in `~/.openclaw/credentials/whatsapp/<accountId>/creds.json`.
- Back-upkopie op `creds.json.bak` (hersteld bij corruptie).
- Legacy-compatibiliteit: oudere installaties sloegen Baileys-bestanden direct op in `~/.openclaw/credentials/`.
- Uitloggen: `openclaw channels logout` (of `--account <id>`) verwijdert de WhatsApp-authenticatiestatus (maar behoudt gedeelde `oauth.json`).
- Uitgelogde socket => fout met instructie om opnieuw te koppelen.

## Inkomende stroom (DM + groep)

- WhatsApp-events komen van `messages.upsert` (Baileys).
- Inbox-listeners worden bij afsluiten losgekoppeld om ophoping van eventhandlers in tests/herstarts te voorkomen.
- Status-/broadcastchats worden genegeerd.
- Directe chats gebruiken E.164; groepen gebruiken group JID.
- **DM-beleid**: `channels.whatsapp.dmPolicy` bepaalt toegang tot directe chats (standaard: `pairing`).
  - Koppelen: onbekende afzenders krijgen een koppelcode (goedkeuren via `openclaw pairing approve whatsapp <code>`; codes verlopen na 1 uur).
  - Open: vereist dat `channels.whatsapp.allowFrom` `"*"` bevat.
  - Je gekoppelde WhatsApp-nummer wordt impliciet vertrouwd, dus zelfberichten slaan de controles `channels.whatsapp.dmPolicy` en `channels.whatsapp.allowFrom` over.

### Persoonlijk-nummer-modus (fallback)

Als je OpenClaw draait op je **persoonlijke WhatsApp-nummer**, schakel `channels.whatsapp.selfChatMode` in (zie voorbeeld hierboven).

Gedrag:

- Uitgaande DM’s triggeren nooit koppelantwoorden (voorkomt het spammen van contacten).
- Inkomende onbekende afzenders volgen nog steeds `channels.whatsapp.dmPolicy`.
- Zelf-chatmodus (allowFrom bevat je nummer) vermijdt automatische leesbevestigingen en negeert mention-JID’s.
- Leesbevestigingen worden verzonden voor niet-zelf-chat DM’s.

## Leesbevestigingen

Standaard markeert de gateway inkomende WhatsApp-berichten als gelezen (blauwe vinkjes) zodra ze zijn geaccepteerd.

Globaal uitschakelen:

```json5
{
  channels: { whatsapp: { sendReadReceipts: false } },
}
```

Per account uitschakelen:

```json5
{
  channels: {
    whatsapp: {
      accounts: {
        personal: { sendReadReceipts: false },
      },
    },
  },
}
```

Notities:

- Zelf-chatmodus slaat leesbevestigingen altijd over.

## WhatsApp FAQ: berichten verzenden + koppelen

**Stuurt OpenClaw willekeurige contacten berichten wanneer ik WhatsApp koppel?**  
Nee. Het standaard DM-beleid is **koppelen**, dus onbekende afzenders krijgen alleen een koppelcode en hun bericht wordt **niet verwerkt**. OpenClaw antwoordt alleen op chats die het ontvangt, of op verzendingen die je expliciet triggert (agent/CLI).

**Hoe werkt koppelen op WhatsApp?**  
Koppelen is een DM-poort voor onbekende afzenders:

- Eerste DM van een nieuwe afzender retourneert een korte code (bericht wordt niet verwerkt).
- Goedkeuren met: `openclaw pairing approve whatsapp <code>` (lijst met `openclaw pairing list whatsapp`).
- Codes verlopen na 1 uur; openstaande verzoeken zijn beperkt tot 3 per kanaal.

**Kunnen meerdere mensen verschillende OpenClaw-instanties gebruiken op één WhatsApp-nummer?**  
Ja, door elke afzender naar een andere agent te routeren via `bindings` (peer `kind: "dm"`, afzender E.164 zoals `+15551234567`). Antwoorden komen nog steeds van **hetzelfde WhatsApp-account**, en directe chats worden samengevoegd tot de hoofdsessie van elke agent, dus gebruik **één agent per persoon**. DM-toegangsbeheer (`dmPolicy`/`allowFrom`) is globaal per WhatsApp-account. Zie [Multi-Agent Routing](/concepts/multi-agent).

**Waarom vraagt de wizard om mijn telefoonnummer?**  
De wizard gebruikt dit om je **toegestane lijst/eigenaar** in te stellen zodat je eigen DM’s zijn toegestaan. Het wordt niet gebruikt voor automatisch verzenden. Als je op je persoonlijke WhatsApp-nummer draait, gebruik datzelfde nummer en schakel `channels.whatsapp.selfChatMode` in.

## Berichtnormalisatie (wat het model ziet)

- `Body` is de huidige berichttekst met envelop.

- Context van geciteerde antwoorden wordt **altijd toegevoegd**:

  ```
  [Replying to +1555 id:ABC123]
  <quoted text or <media:...>>
  [/Replying]
  ```

- Antwoordmetadata wordt ook ingesteld:
  - `ReplyToId` = stanzaId
  - `ReplyToBody` = geciteerde tekst of media-placeholder
  - `ReplyToSender` = E.164 indien bekend

- Inkomende berichten met alleen media gebruiken placeholders:
  - `<media:image|video|audio|document|sticker>`

## Groepen

- Groepen mappen naar `agent:<agentId>:whatsapp:group:<jid>`-sessies.
- Groepsbeleid: `channels.whatsapp.groupPolicy = open|disabled|allowlist` (standaard `allowlist`).
- Activatiemodi:
  - `mention` (standaard): vereist @vermelding of regex-match.
  - `always`: triggert altijd.
- `/activation mention|always` is alleen voor de eigenaar en moet als zelfstandig bericht worden verzonden.
- Eigenaar = `channels.whatsapp.allowFrom` (of zelf E.164 indien niet ingesteld).
- **Geschiedenisinjectie** (alleen in behandeling):
  - Recente _niet-verwerkte_ berichten (standaard 50) ingevoegd onder:
    `[Chat messages since your last reply - for context]` (berichten die al in de sessie staan worden niet opnieuw geïnjecteerd)
  - Huidig bericht onder:
    `[Current message - respond to this]`
  - Afzender-suffix toegevoegd: `[from: Name (+E164)]`
- Groepsmetadata wordt 5 min gecachet (onderwerp + deelnemers).

## Aflevering van antwoorden (threading)

- WhatsApp Web verzendt standaardberichten (geen geciteerde antwoord-threading in de huidige gateway).
- Antwoordtags worden op dit kanaal genegeerd.

## Bevestigingsreacties (automatisch reageren bij ontvangst)

WhatsApp kan automatisch emoji-reacties verzenden op inkomende berichten direct bij ontvangst, voordat de bot een antwoord genereert. Dit geeft gebruikers onmiddellijke feedback dat hun bericht is ontvangen.

**Configuratie:**

```json
{
  "whatsapp": {
    "ackReaction": {
      "emoji": "👀",
      "direct": true,
      "group": "mentions"
    }
  }
}
```

**Opties:**

- `emoji` (string): Emoji voor bevestiging (bijv. "👀", "✅", "📨"). Leeg of weggelaten = functie uitgeschakeld.
- `direct` (boolean, standaard: `true`): Reacties verzenden in directe/DM-chats.
- `group` (string, standaard: `"mentions"`): Gedrag in groepschats:
  - `"always"`: Reageer op alle groepsberichten (zelfs zonder @vermelding)
  - `"mentions"`: Reageer alleen wanneer de bot wordt @vermeld
  - `"never"`: Nooit reageren in groepen

**Per-account override:**

```json
{
  "whatsapp": {
    "accounts": {
      "work": {
        "ackReaction": {
          "emoji": "✅",
          "direct": false,
          "group": "always"
        }
      }
    }
  }
}
```

**Gedragsnotities:**

- Reacties worden **onmiddellijk** verzonden bij ontvangst van het bericht, vóór typindicatoren of botantwoorden.
- In groepen met `requireMention: false` (activatie: altijd) zal `group: "mentions"` op alle berichten reageren (niet alleen @vermeldingen).
- Fire-and-forget: mislukte reacties worden gelogd maar verhinderen het antwoorden van de bot niet.
- De JID van de deelnemer wordt automatisch toegevoegd voor groepsreacties.
- WhatsApp negeert `messages.ackReaction`; gebruik `channels.whatsapp.ackReaction` in plaats daarvan.

## Agent-tool (reacties)

- Tool: `whatsapp` met actie `react` (`chatJid`, `messageId`, `emoji`, optioneel `remove`).
- Optioneel: `participant` (groepsafzender), `fromMe` (reageren op je eigen bericht), `accountId` (multi-account).
- Semantiek voor het verwijderen van reacties: zie [/tools/reactions](/tools/reactions).
- Tool-gating: `channels.whatsapp.actions.reactions` (standaard: ingeschakeld).

## Beperkingen

- Uitgaande tekst wordt opgeknipt tot `channels.whatsapp.textChunkLimit` (standaard 4000).
- Optioneel splitsen op nieuwe regels: stel `channels.whatsapp.chunkMode="newline"` in om op lege regels (paragraafgrenzen) te splitsen vóór lengte-opknippen.
- Opslag van inkomende media is begrensd door `channels.whatsapp.mediaMaxMb` (standaard 50 MB).
- Uitgaande media-items zijn begrensd door `agents.defaults.mediaMaxMb` (standaard 5 MB).

## Uitgaand verzenden (tekst + media)

- Gebruikt actieve web-listener; fout als de gateway niet draait.
- Tekst-opknippen: max. 4k per bericht (configureerbaar via `channels.whatsapp.textChunkLimit`, optioneel `channels.whatsapp.chunkMode`).
- Media:
  - Afbeelding/video/audio/document ondersteund.
  - Audio wordt verzonden als PTT; `audio/ogg` => `audio/ogg; codecs=opus`.
  - Bijschrift alleen bij het eerste media-item.
  - Media-ophalen ondersteunt HTTP(S) en lokale paden.
  - Geanimeerde GIF’s: WhatsApp verwacht MP4 met `gifPlayback: true` voor inline looping.
    - CLI: `openclaw message send --media <mp4> --gif-playback`
    - Gateway: `send`-parameters bevatten `gifPlayback: true`

## Spraaknotities (PTT-audio)

WhatsApp verzendt audio als **spraaknotities** (PTT-bubbel).

- Beste resultaten: OGG/Opus. OpenClaw herschrijft `audio/ogg` naar `audio/ogg; codecs=opus`.
- `[[audio_as_voice]]` wordt voor WhatsApp genegeerd (audio wordt al als spraaknotitie verzonden).

## Medialimieten + optimalisatie

- Standaard uitgaande limiet: 5 MB (per media-item).
- Overschrijven: `agents.defaults.mediaMaxMb`.
- Afbeeldingen worden automatisch geoptimaliseerd naar JPEG onder de limiet (resizen + kwaliteits-sweep).
- Te grote media => fout; media-antwoord valt terug op tekstwaarschuwing.

## Heartbeats

- **Gateway-heartbeat** logt verbindingsgezondheid (`web.heartbeatSeconds`, standaard 60s).
- **Agent-heartbeat** kan per agent worden geconfigureerd (`agents.list[].heartbeat`) of globaal
  via `agents.defaults.heartbeat` (fallback wanneer geen per-agent entries zijn ingesteld).
  - Gebruikt de geconfigureerde heartbeat-prompt (standaard: `Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`) + `HEARTBEAT_OK`-skipgedrag.
  - Aflevering gebeurt standaard via het laatst gebruikte kanaal (of geconfigureerd doel).

## Gedrag opnieuw verbinden

- Backoff-beleid: `web.reconnect`:
  - `initialMs`, `maxMs`, `factor`, `jitter`, `maxAttempts`.
- Als maxAttempts is bereikt, stopt webmonitoring (gedegradeerd).
- Uitgelogd => stoppen en opnieuw koppelen vereist.

## Config-sneloverzicht

- `channels.whatsapp.dmPolicy` (DM-beleid: koppelen/toegestane lijst/open/uitgeschakeld).
- `channels.whatsapp.selfChatMode` (zelfde-telefoon-setup; bot gebruikt je persoonlijke WhatsApp-nummer).
- `channels.whatsapp.allowFrom` (DM-toegestane lijst). WhatsApp gebruikt E.164-telefoonnummers (geen gebruikersnamen).
- `channels.whatsapp.mediaMaxMb` (limiet voor opslaan van inkomende media).
- `channels.whatsapp.ackReaction` (auto-reactie bij ontvangst van berichten: `{emoji, direct, group}`).
- `channels.whatsapp.accounts.<accountId>.*` (per-accountinstellingen + optioneel `authDir`).
- `channels.whatsapp.accounts.<accountId>.mediaMaxMb` (per-accountlimiet voor inkomende media).
- `channels.whatsapp.accounts.<accountId>.ackReaction` (per-account override voor bevestigingsreactie).
- `channels.whatsapp.groupAllowFrom` (toegestane lijst voor groepsafzenders).
- `channels.whatsapp.groupPolicy` (groepsbeleid).
- `channels.whatsapp.historyLimit` / `channels.whatsapp.accounts.<accountId>.historyLimit` (groepsgeschiedeniscontext; `0` schakelt uit).
- `channels.whatsapp.dmHistoryLimit` (DM-geschiedenislimeit in gebruikersbeurten). Per-gebruiker overrides: `channels.whatsapp.dms["<phone>"].historyLimit`.
- `channels.whatsapp.groups` (groeps-toegestane lijst + mention-gating-standaarden; gebruik `"*"` om alles toe te staan)
- `channels.whatsapp.actions.reactions` (gate WhatsApp-toolreacties).
- `agents.list[].groupChat.mentionPatterns` (of `messages.groupChat.mentionPatterns`)
- `messages.groupChat.historyLimit`
- `channels.whatsapp.messagePrefix` (inkomend voorvoegsel; per account: `channels.whatsapp.accounts.<accountId>.messagePrefix`; verouderd: `messages.messagePrefix`)
- `messages.responsePrefix` (uitgaand voorvoegsel)
- `agents.defaults.mediaMaxMb`
- `agents.defaults.heartbeat.every`
- `agents.defaults.heartbeat.model` (optionele override)
- `agents.defaults.heartbeat.target`
- `agents.defaults.heartbeat.to`
- `agents.defaults.heartbeat.session`
- `agents.list[].heartbeat.*` (per-agent overrides)
- `session.*` (scope, idle, store, mainKey)
- `web.enabled` (schakelt kanaalstart uit wanneer false)
- `web.heartbeatSeconds`
- `web.reconnect.*`

## Logs + problemen oplossen

- Subsystemen: `whatsapp/inbound`, `whatsapp/outbound`, `web-heartbeat`, `web-reconnect`.
- Logbestand: `/tmp/openclaw/openclaw-YYYY-MM-DD.log` (configureerbaar).
- Probleemoplossingsgids: [Gateway troubleshooting](/gateway/troubleshooting).

## Problemen oplossen (snel)

**Niet gekoppeld / QR-inloggen vereist**

- Symptoom: `channels status` toont `linked: false` of waarschuwt “Not linked”.
- Oplossing: voer `openclaw channels login` uit op de Gateway-host en scan de QR (WhatsApp → Instellingen → Gekoppelde apparaten).

**Gekoppeld maar verbroken / herverbindlus**

- Symptoom: `channels status` toont `running, disconnected` of waarschuwt “Linked but disconnected”.
- Oplossing: `openclaw doctor` (of herstart de gateway). Als het aanhoudt, koppel opnieuw via `channels login` en inspecteer `openclaw logs --follow`.

**Bun-runtime**

- Bun wordt **niet aanbevolen**. WhatsApp (Baileys) en Telegram zijn onbetrouwbaar op Bun.
  Draai de gateway met **Node**. (Zie runtime-opmerking bij Aan de slag.)
