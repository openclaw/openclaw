---
summary: "WhatsApp‑integration (webbkanal): inloggning, inkorg, svar, media och drift"
read_when:
  - Arbetar med WhatsApp/webbkanalens beteende eller inkorgsroutning
title: "WhatsApp"
x-i18n:
  source_path: channels/whatsapp.md
  source_hash: 9f7acdf2c71819ae
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:17:03Z
---

# WhatsApp (webbkanal)

Status: Endast WhatsApp Web via Baileys. Gateway äger sessionen/s.

## Snabbstart (nybörjare)

1. Använd ett **separat telefonnummer** om möjligt (rekommenderas).
2. Konfigurera WhatsApp i `~/.openclaw/openclaw.json`.
3. Kör `openclaw channels login` för att skanna QR‑koden (Länkade enheter).
4. Starta gatewayen.

Minimal konfiguration:

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

## Mål

- Flera WhatsApp‑konton (multi‑account) i en Gateway‑process.
- Deterministisk routning: svar går tillbaka till WhatsApp, ingen modellroutning.
- Modellen ser tillräcklig kontext för att förstå citerade svar.

## Konfigskrivningar

Som standard får WhatsApp skriva konfiguppdateringar som triggas av `/config set|unset` (kräver `commands.config: true`).

Inaktivera med:

```json5
{
  channels: { whatsapp: { configWrites: false } },
}
```

## Arkitektur (vem äger vad)

- **Gateway** äger Baileys‑socketen och inkorgsloopen.
- **CLI / macOS‑app** pratar med gatewayen; ingen direkt användning av Baileys.
- **Aktiv lyssnare** krävs för utgående sändningar; annars misslyckas sändningen direkt.

## Skaffa ett telefonnummer (två lägen)

WhatsApp kräver ett riktigt mobilnummer för verifiering. VoIP‑ och virtuella nummer blockeras oftast. Det finns två stödda sätt att köra OpenClaw på WhatsApp:

### Dedikerat nummer (rekommenderas)

Använd ett **separat telefonnummer** för OpenClaw. Bästa UX, ren routning, inga egen‑chatt‑egenheter. Idealisk setup: **reserv/gammal Android‑telefon + eSIM**. Låt den vara på Wi‑Fi och ström, och länka via QR.

**WhatsApp Business:** Du kan använda WhatsApp Business på samma enhet med ett annat nummer. Perfekt för att hålla din personliga WhatsApp separat — installera WhatsApp Business och registrera OpenClaw‑numret där.

**Exempelkonfig (dedikerat nummer, allowlist för en användare):**

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

**Parningsläge (valfritt):**  
Om du vill använda parning i stället för allowlist, sätt `channels.whatsapp.dmPolicy` till `pairing`. Okända avsändare får en parningskod; godkänn med:
`openclaw pairing approve whatsapp <code>`

### Personligt nummer (reserv)

Snabb reserv: kör OpenClaw på **ditt eget nummer**. Skicka meddelanden till dig själv (WhatsApp ”Meddelande till dig själv”) för testning så att du inte spammar kontakter. Räkna med att läsa verifieringskoder på din huvudtelefon under installation och experiment. **Måste aktivera egen‑chatt‑läge.**  
När guiden frågar efter ditt personliga WhatsApp‑nummer, ange telefonen du kommer att skicka från (ägaren/avsändaren), inte assistentens nummer.

**Exempelkonfig (personligt nummer, egen‑chatt):**

```json
{
  "whatsapp": {
    "selfChatMode": true,
    "dmPolicy": "allowlist",
    "allowFrom": ["+15551234567"]
  }
}
```

Svar i egen‑chatt använder som standard `[{identity.name}]` när det är satt (annars `[openclaw]`)
om `messages.responsePrefix` inte är satt. Sätt det explicit för att anpassa eller inaktivera
prefixet (använd `""` för att ta bort det).

### Tips för nummeranskaffning

- **Lokalt eSIM** från ditt lands mobiloperatör (mest tillförlitligt)
  - Österrike: [hot.at](https://www.hot.at)
  - Storbritannien: [giffgaff](https://www.giffgaff.com) — gratis SIM, inget avtal
- **Kontantkort** — billigt, behöver bara ta emot ett SMS för verifiering

**Undvik:** TextNow, Google Voice, de flesta ”gratis SMS”‑tjänster — WhatsApp blockerar dessa aggressivt.

**Tips:** Numret behöver bara ta emot ett verifierings‑SMS. Därefter består WhatsApp Web‑sessioner via `creds.json`.

## Varför inte Twilio?

- Tidiga OpenClaw‑byggen stödde Twilios WhatsApp Business‑integration.
- WhatsApp Business‑nummer passar dåligt för en personlig assistent.
- Meta upprätthåller ett 24‑timmars svarsfönster; om du inte har svarat de senaste 24 timmarna kan företagsnumret inte initiera nya meddelanden.
- Hög volym eller ”pratig” användning triggar aggressiv blockering, eftersom företagskonton inte är avsedda att skicka dussintals personliga assistentmeddelanden.
- Resultat: opålitlig leverans och frekventa blockeringar, därför togs stödet bort.

## Inloggning + autentiseringsuppgifter

- Inloggningskommando: `openclaw channels login` (QR via Länkade enheter).
- Multi‑account‑inloggning: `openclaw channels login --account <id>` (`<id>` = `accountId`).
- Standardkonto (när `--account` utelämnas): `default` om det finns, annars första konfigurerade konto‑ID (sorterat).
- Autentiseringsuppgifter lagras i `~/.openclaw/credentials/whatsapp/<accountId>/creds.json`.
- Säkerhetskopia i `creds.json.bak` (återställs vid korruption).
- Bakåtkompatibilitet: äldre installationer lagrade Baileys‑filer direkt i `~/.openclaw/credentials/`.
- Utloggning: `openclaw channels logout` (eller `--account <id>`) raderar WhatsApp‑auth‑tillståndet (men behåller delad `oauth.json`).
- Utloggad socket ⇒ fel som instruerar att länka igen.

## Inkommande flöde (DM + grupp)

- WhatsApp‑händelser kommer från `messages.upsert` (Baileys).
- Inkorgslyssnare kopplas bort vid nedstängning för att undvika ackumulerade händelsehanterare vid tester/omstarter.
- Status-/broadcast‑chattar ignoreras.
- Direktchattar använder E.164; grupper använder grupp‑JID.
- **DM‑policy**: `channels.whatsapp.dmPolicy` styr åtkomst till direktchatt (standard: `pairing`).
  - Parning: okända avsändare får en parningskod (godkänn via `openclaw pairing approve whatsapp <code>`; koder upphör efter 1 timme).
  - Öppen: kräver att `channels.whatsapp.allowFrom` inkluderar `"*"`.
  - Ditt länkade WhatsApp‑nummer är implicit betrott, så egna meddelanden hoppar över kontrollerna `channels.whatsapp.dmPolicy` och `channels.whatsapp.allowFrom`.

### Personligt‑nummer‑läge (reserv)

Om du kör OpenClaw på **ditt personliga WhatsApp‑nummer**, aktivera `channels.whatsapp.selfChatMode` (se exempel ovan).

Beteende:

- Utgående DM triggar aldrig parningssvar (förhindrar spam till kontakter).
- Inkommande okända avsändare följer fortfarande `channels.whatsapp.dmPolicy`.
- Egen‑chatt‑läge (allowFrom inkluderar ditt nummer) undviker automatiska läskvitton och ignorerar mention‑JID.
- Läskvitton skickas för DM som inte är egen‑chatt.

## Läskvitton

Som standard markerar gatewayen inkommande WhatsApp‑meddelanden som lästa (blå bockar) när de accepteras.

Inaktivera globalt:

```json5
{
  channels: { whatsapp: { sendReadReceipts: false } },
}
```

Inaktivera per konto:

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

Noteringar:

- Egen‑chatt‑läge hoppar alltid över läskvitton.

## WhatsApp‑FAQ: skicka meddelanden + parning

**Kommer OpenClaw att meddela slumpmässiga kontakter när jag länkar WhatsApp?**  
Nej. Standard‑DM‑policy är **parning**, så okända avsändare får bara en parningskod och deras meddelande **behandlas inte**. OpenClaw svarar bara på chattar den tar emot, eller på sändningar du explicit triggar (agent/CLI).

**Hur fungerar parning på WhatsApp?**  
Parning är en DM‑grind för okända avsändare:

- Första DM från en ny avsändare returnerar en kort kod (meddelandet behandlas inte).
- Godkänn med: `openclaw pairing approve whatsapp <code>` (lista med `openclaw pairing list whatsapp`).
- Koder upphör efter 1 timme; väntande förfrågningar är begränsade till 3 per kanal.

**Kan flera personer använda olika OpenClaw‑instanser på ett WhatsApp‑nummer?**  
Ja, genom att routa varje avsändare till en annan agent via `bindings` (peer `kind: "dm"`, avsändar‑E.164 som `+15551234567`). Svar kommer fortfarande från **samma WhatsApp‑konto**, och direktchattar kollapsar till varje agents huvudsession, så använd **en agent per person**. DM‑åtkomstkontroll (`dmPolicy`/`allowFrom`) är global per WhatsApp‑konto. Se [Multi‑Agent Routing](/concepts/multi-agent).

**Varför frågar guiden efter mitt telefonnummer?**  
Guiden använder det för att sätta din **allowlist/ägare** så att dina egna DM tillåts. Det används inte för automatisk sändning. Om du kör på ditt personliga WhatsApp‑nummer, använd samma nummer och aktivera `channels.whatsapp.selfChatMode`.

## Meddelandenormalisering (vad modellen ser)

- `Body` är aktuell meddelandetext med kuvert.
- Kontext för citerade svar **läggs alltid till**:

  ```
  [Replying to +1555 id:ABC123]
  <quoted text or <media:...>>
  [/Replying]
  ```

- Svarsmetadata sätts också:
  - `ReplyToId` = stanzaId
  - `ReplyToBody` = citerad text eller mediaplatshållare
  - `ReplyToSender` = E.164 när känt
- Inkommande meddelanden med enbart media använder platshållare:
  - `<media:image|video|audio|document|sticker>`

## Grupper

- Grupper mappar till `agent:<agentId>:whatsapp:group:<jid>`‑sessioner.
- Gruppolicy: `channels.whatsapp.groupPolicy = open|disabled|allowlist` (standard `allowlist`).
- Aktiveringslägen:
  - `mention` (standard): kräver @omnämnande eller regex‑träff.
  - `always`: triggar alltid.
- `/activation mention|always` är endast för ägare och måste skickas som ett fristående meddelande.
- Ägare = `channels.whatsapp.allowFrom` (eller egen E.164 om ej satt).
- **Historikinjektion** (endast väntande):
  - Nyliga _obehandlade_ meddelanden (standard 50) infogas under:
    `[Chat messages since your last reply - for context]` (meddelanden som redan finns i sessionen återinjekteras inte)
  - Aktuellt meddelande under:
    `[Current message - respond to this]`
  - Avsändarsuffix läggs till: `[from: Name (+E164)]`
- Gruppmetadata cachelagras i 5 min (ämne + deltagare).

## Leverans av svar (trådning)

- WhatsApp Web skickar standardmeddelanden (ingen citerad svars‑trådning i nuvarande gateway).
- Svarstaggar ignoreras på denna kanal.

## Bekräftelsereaktioner (auto‑reaktion vid mottagning)

WhatsApp kan automatiskt skicka emoji‑reaktioner till inkommande meddelanden omedelbart vid mottagning, innan boten genererar ett svar. Detta ger användare direkt feedback att deras meddelande mottogs.

**Konfiguration:**

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

**Alternativ:**

- `emoji` (sträng): Emoji som används för bekräftelse (t.ex. "👀", "✅", "📨"). Tom eller utelämnad = funktionen inaktiverad.
- `direct` (boolesk, standard: `true`): Skicka reaktioner i direkt-/DM‑chattar.
- `group` (sträng, standard: `"mentions"`): Beteende i gruppchattar:
  - `"always"`: Reagera på alla gruppmeddelanden (även utan @omnämnande)
  - `"mentions"`: Reagera endast när boten @omnämns
  - `"never"`: Reagera aldrig i grupper

**Åsidosättning per konto:**

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

**Beteendenoteringar:**

- Reaktioner skickas **omedelbart** vid mottagning av meddelandet, före skrivindikatorer eller botsvar.
- I grupper med `requireMention: false` (aktivering: alltid) kommer `group: "mentions"` att reagera på alla meddelanden (inte bara @omnämnanden).
- Fire‑and‑forget: misslyckade reaktioner loggas men hindrar inte boten från att svara.
- Deltagar‑JID inkluderas automatiskt för gruppreaktioner.
- WhatsApp ignorerar `messages.ackReaction`; använd `channels.whatsapp.ackReaction` i stället.

## Agentverktyg (reaktioner)

- Verktyg: `whatsapp` med åtgärden `react` (`chatJid`, `messageId`, `emoji`, valfri `remove`).
- Valfritt: `participant` (gruppavsändare), `fromMe` (reagera på eget meddelande), `accountId` (multi‑account).
- Semantik för borttagning av reaktioner: se [/tools/reactions](/tools/reactions).
- Verktygsgating: `channels.whatsapp.actions.reactions` (standard: aktiverad).

## Begränsningar

- Utgående text delas upp till `channels.whatsapp.textChunkLimit` (standard 4000).
- Valfri radbrytnings‑chunkning: sätt `channels.whatsapp.chunkMode="newline"` för att dela på tomma rader (styckegränser) före längd‑chunkning.
- Sparade inkommande media begränsas av `channels.whatsapp.mediaMaxMb` (standard 50 MB).
- Utgående mediaobjekt begränsas av `agents.defaults.mediaMaxMb` (standard 5 MB).

## Utgående sändning (text + media)

- Använder aktiv webblyssnare; fel om gatewayen inte körs.
- Text‑chunkning: max 4k per meddelande (konfigurerbart via `channels.whatsapp.textChunkLimit`, valfri `channels.whatsapp.chunkMode`).
- Media:
  - Bild/video/ljud/dokument stöds.
  - Ljud skickas som PTT; `audio/ogg` ⇒ `audio/ogg; codecs=opus`.
  - Bildtext endast på första mediaobjektet.
  - Mediahämtning stöder HTTP(S) och lokala sökvägar.
  - Animerade GIF: WhatsApp förväntar sig MP4 med `gifPlayback: true` för inline‑loopning.
    - CLI: `openclaw message send --media <mp4> --gif-playback`
    - Gateway: `send`‑parametrar inkluderar `gifPlayback: true`

## Röstmeddelanden (PTT‑ljud)

WhatsApp skickar ljud som **röstmeddelanden** (PTT‑bubbla).

- Bäst resultat: OGG/Opus. OpenClaw skriver om `audio/ogg` till `audio/ogg; codecs=opus`.
- `[[audio_as_voice]]` ignoreras för WhatsApp (ljud skickas redan som röstmeddelande).

## Mediebegränsningar + optimering

- Standardtak utgående: 5 MB (per mediaobjekt).
- Åsidosättning: `agents.defaults.mediaMaxMb`.
- Bilder optimeras automatiskt till JPEG under taket (storleksändring + kvalitets‑svep).
- För stora media ⇒ fel; mediasvar faller tillbaka till textvarning.

## Heartbeats

- **Gateway‑heartbeat** loggar anslutningshälsa (`web.heartbeatSeconds`, standard 60 s).
- **Agent‑heartbeat** kan konfigureras per agent (`agents.list[].heartbeat`) eller globalt
  via `agents.defaults.heartbeat` (reserv när inga per‑agent‑poster är satta).
  - Använder den konfigurerade heartbeat‑prompten (standard: `Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`) + `HEARTBEAT_OK`‑skip‑beteende.
  - Leverans går som standard till senast använda kanal (eller konfigurerat mål).

## Återanslutningsbeteende

- Backoff‑policy: `web.reconnect`:
  - `initialMs`, `maxMs`, `factor`, `jitter`, `maxAttempts`.
- Om maxAttempts nås stoppas webbövervakning (degraderat läge).
- Utloggad ⇒ stoppa och kräv återlänkning.

## Snabbkarta för konfig

- `channels.whatsapp.dmPolicy` (DM‑policy: parning/allowlist/öppen/inaktiverad).
- `channels.whatsapp.selfChatMode` (samma‑telefon‑setup; boten använder ditt personliga WhatsApp‑nummer).
- `channels.whatsapp.allowFrom` (DM‑allowlist). WhatsApp använder E.164‑telefonnummer (inga användarnamn).
- `channels.whatsapp.mediaMaxMb` (tak för sparad inkommande media).
- `channels.whatsapp.ackReaction` (auto‑reaktion vid mottagning: `{emoji, direct, group}`).
- `channels.whatsapp.accounts.<accountId>.*` (per‑konto‑inställningar + valfri `authDir`).
- `channels.whatsapp.accounts.<accountId>.mediaMaxMb` (per‑konto‑tak för inkommande media).
- `channels.whatsapp.accounts.<accountId>.ackReaction` (åsidosättning av bekräftelsereaktion per konto).
- `channels.whatsapp.groupAllowFrom` (allowlist för gruppavsändare).
- `channels.whatsapp.groupPolicy` (gruppolicy).
- `channels.whatsapp.historyLimit` / `channels.whatsapp.accounts.<accountId>.historyLimit` (grupphistorik‑kontext; `0` inaktiverar).
- `channels.whatsapp.dmHistoryLimit` (DM‑historikgräns i användarturer). Åsidosättningar per användare: `channels.whatsapp.dms["<phone>"].historyLimit`.
- `channels.whatsapp.groups` (grupp‑allowlist + standard för mention‑gating; använd `"*"` för att tillåta alla)
- `channels.whatsapp.actions.reactions` (grind för WhatsApp‑verktygsreaktioner).
- `agents.list[].groupChat.mentionPatterns` (eller `messages.groupChat.mentionPatterns`)
- `messages.groupChat.historyLimit`
- `channels.whatsapp.messagePrefix` (inkommande prefix; per konto: `channels.whatsapp.accounts.<accountId>.messagePrefix`; föråldrat: `messages.messagePrefix`)
- `messages.responsePrefix` (utgående prefix)
- `agents.defaults.mediaMaxMb`
- `agents.defaults.heartbeat.every`
- `agents.defaults.heartbeat.model` (valfri åsidosättning)
- `agents.defaults.heartbeat.target`
- `agents.defaults.heartbeat.to`
- `agents.defaults.heartbeat.session`
- `agents.list[].heartbeat.*` (åsidosättningar per agent)
- `session.*` (scope, idle, store, mainKey)
- `web.enabled` (inaktivera kanalstart när false)
- `web.heartbeatSeconds`
- `web.reconnect.*`

## Loggar + felsökning

- Delssystem: `whatsapp/inbound`, `whatsapp/outbound`, `web-heartbeat`, `web-reconnect`.
- Loggfil: `/tmp/openclaw/openclaw-YYYY-MM-DD.log` (konfigurerbar).
- Felsökningsguide: [Gateway troubleshooting](/gateway/troubleshooting).

## Felsökning (snabb)

**Inte länkad / QR‑inloggning krävs**

- Symptom: `channels status` visar `linked: false` eller varnar ”Not linked”.
- Åtgärd: kör `openclaw channels login` på gateway‑värden och skanna QR‑koden (WhatsApp → Inställningar → Länkade enheter).

**Länkad men frånkopplad / återanslutningsloop**

- Symptom: `channels status` visar `running, disconnected` eller varnar ”Linked but disconnected”.
- Åtgärd: `openclaw doctor` (eller starta om gatewayen). Om det kvarstår, länka om via `channels login` och inspektera `openclaw logs --follow`.

**Bun‑runtime**

- Bun **rekommenderas inte**. WhatsApp (Baileys) och Telegram är opålitliga på Bun.
  Kör gatewayen med **Node**. (Se runtime‑notis i Kom igång.)
