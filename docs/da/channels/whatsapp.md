---
summary: "WhatsApp (webkanal) integration: login, indbakke, svar, medier og drift"
read_when:
  - Arbejde med WhatsApp/webkanal-adfærd eller routing i indbakken
title: "WhatsApp"
x-i18n:
  source_path: channels/whatsapp.md
  source_hash: 9f7acdf2c71819ae
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:34Z
---

# WhatsApp (webkanal)

Status: Kun WhatsApp Web via Baileys. Gateway ejer sessionen/sessionerne.

## Hurtig opsætning (begynder)

1. Brug et **separat telefonnummer** hvis muligt (anbefalet).
2. Konfigurér WhatsApp i `~/.openclaw/openclaw.json`.
3. Kør `openclaw channels login` for at scanne QR-koden (Forbundne enheder).
4. Start gateway.

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

- Flere WhatsApp-konti (multi-account) i én Gateway-proces.
- Deterministisk routing: svar returnerer til WhatsApp, ingen model-routing.
- Modellen ser nok kontekst til at forstå citerede svar.

## Konfigurationsskrivninger

Som standard må WhatsApp skrive konfigurationsopdateringer udløst af `/config set|unset` (kræver `commands.config: true`).

Deaktiver med:

```json5
{
  channels: { whatsapp: { configWrites: false } },
}
```

## Arkitektur (hvem ejer hvad)

- **Gateway** ejer Baileys-socket og indbakke-loop.
- **CLI / macOS-app** taler med gateway; ingen direkte Baileys-brug.
- **Aktiv lytter** er påkrævet for udgående afsendelser; ellers fejler afsendelse straks.

## Få et telefonnummer (to tilstande)

WhatsApp kræver et rigtigt mobilnummer til verifikation. VoIP- og virtuelle numre blokeres som regel. Der er to understøttede måder at køre OpenClaw på WhatsApp:

### Dedikeret nummer (anbefalet)

Brug et **separat telefonnummer** til OpenClaw. Bedste UX, ren routing, ingen selv-chat-quirks. Ideel opsætning: **ekstra/gammel Android-telefon + eSIM**. Lad den være på Wi‑Fi og strøm, og link den via QR.

**WhatsApp Business:** Du kan bruge WhatsApp Business på samme enhed med et andet nummer. Perfekt til at holde din personlige WhatsApp adskilt — installér WhatsApp Business og registrér OpenClaw-nummeret dér.

**Eksempelkonfiguration (dedikeret nummer, enkeltbruger-tilladelsesliste):**

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

**Parringstilstand (valgfrit):**  
Hvis du vil bruge parring i stedet for tilladelsesliste, så sæt `channels.whatsapp.dmPolicy` til `pairing`. Ukendte afsendere får en parringskode; godkend med:  
`openclaw pairing approve whatsapp <code>`

### Personligt nummer (fallback)

Hurtig fallback: kør OpenClaw på **dit eget nummer**. Skriv til dig selv (WhatsApp “Besked til dig selv”) for test, så du ikke spammer kontakter. Forvent at læse verifikationskoder på din primære telefon under opsætning og eksperimenter. **Selv-chat-tilstand skal aktiveres.**  
Når guiden beder om dit personlige WhatsApp-nummer, skal du indtaste den telefon, du vil skrive fra (ejeren/afsenderen), ikke assistentens nummer.

**Eksempelkonfiguration (personligt nummer, selv-chat):**

```json
{
  "whatsapp": {
    "selfChatMode": true,
    "dmPolicy": "allowlist",
    "allowFrom": ["+15551234567"]
  }
}
```

Svar i selv-chat har som standard `[{identity.name}]` når sat (ellers `[openclaw]`)  
hvis `messages.responsePrefix` ikke er sat. Sæt den eksplicit for at tilpasse eller deaktivere  
præfikset (brug `""` for at fjerne det).

### Tips til nummeranskaffelse

- **Lokalt eSIM** fra dit lands mobiloperatør (mest pålideligt)
  - Østrig: [hot.at](https://www.hot.at)
  - UK: [giffgaff](https://www.giffgaff.com) — gratis SIM, ingen kontrakt
- **Forudbetalt SIM** — billigt, skal blot kunne modtage én SMS til verifikation

**Undgå:** TextNow, Google Voice, de fleste “gratis SMS”-tjenester — WhatsApp blokerer dem aggressivt.

**Tip:** Nummeret skal kun kunne modtage én verifikations-SMS. Derefter persisterer WhatsApp Web-sessioner via `creds.json`.

## Hvorfor ikke Twilio?

- Tidlige OpenClaw-builds understøttede Twilios WhatsApp Business-integration.
- WhatsApp Business-numre er et dårligt match til en personlig assistent.
- Meta håndhæver et 24-timers svarvindue; hvis du ikke har svaret inden for de sidste 24 timer, kan business-nummeret ikke starte nye beskeder.
- Høj volumen eller “snakkende” brug udløser aggressiv blokering, fordi business-konti ikke er beregnet til at sende dusinvis af personlige assistentbeskeder.
- Resultat: upålidelig levering og hyppige blokeringer, så understøttelsen blev fjernet.

## Login + legitimationsoplysninger

- Login-kommando: `openclaw channels login` (QR via Forbundne enheder).
- Multi-account login: `openclaw channels login --account <id>` (`<id>` = `accountId`).
- Standardkonto (når `--account` udelades): `default` hvis til stede, ellers den første konfigurerede konto-id (sorteret).
- Legitimation gemmes i `~/.openclaw/credentials/whatsapp/<accountId>/creds.json`.
- Backupkopi i `creds.json.bak` (gendannes ved korruption).
- Legacy-kompatibilitet: ældre installationer gemte Baileys-filer direkte i `~/.openclaw/credentials/`.
- Logout: `openclaw channels logout` (eller `--account <id>`) sletter WhatsApp-auth state (men bevarer delt `oauth.json`).
- Udlåget socket => fejl instruerer i at linke igen.

## Indgående flow (DM + gruppe)

- WhatsApp-events kommer fra `messages.upsert` (Baileys).
- Indbakke-lyttere frakobles ved nedlukning for at undgå ophobning af event-handlere i tests/genstarter.
- Status-/broadcast-chats ignoreres.
- Direkte chats bruger E.164; grupper bruger gruppe-JID.
- **DM-politik**: `channels.whatsapp.dmPolicy` styrer adgang til direkte chats (standard: `pairing`).
  - Parring: ukendte afsendere får en parringskode (godkend via `openclaw pairing approve whatsapp <code>`; koder udløber efter 1 time).
  - Åben: kræver at `channels.whatsapp.allowFrom` inkluderer `"*"`.
  - Dit linkede WhatsApp-nummer er implicit betroet, så selvbeskeder springer `channels.whatsapp.dmPolicy`- og `channels.whatsapp.allowFrom`-tjek over.

### Personligt-nummer-tilstand (fallback)

Hvis du kører OpenClaw på **dit personlige WhatsApp-nummer**, så aktivér `channels.whatsapp.selfChatMode` (se eksempel ovenfor).

Adfærd:

- Udgående DM’er udløser aldrig parringssvar (forhindrer spam af kontakter).
- Indgående ukendte afsendere følger stadig `channels.whatsapp.dmPolicy`.
- Selv-chat-tilstand (allowFrom inkluderer dit nummer) undgår automatiske læsekvitteringer og ignorerer mention-JID’er.
- Læsekvitteringer sendes for ikke-selv-chat-DM’er.

## Læsekvitteringer

Som standard markerer gateway indgående WhatsApp-beskeder som læst (blå flueben), når de accepteres.

Deaktivér globalt:

```json5
{
  channels: { whatsapp: { sendReadReceipts: false } },
}
```

Deaktivér pr. konto:

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

Noter:

- Selv-chat-tilstand springer altid læsekvitteringer over.

## WhatsApp FAQ: afsendelse af beskeder + parring

**Vil OpenClaw skrive til tilfældige kontakter, når jeg linker WhatsApp?**  
Nej. Standard DM-politik er **parring**, så ukendte afsendere får kun en parringskode, og deres besked **behandles ikke**. OpenClaw svarer kun på chats, den modtager, eller på afsendelser, du eksplicit udløser (agent/CLI).

**Hvordan virker parring på WhatsApp?**  
Parring er en DM-gate for ukendte afsendere:

- Første DM fra en ny afsender returnerer en kort kode (beskeden behandles ikke).
- Godkend med: `openclaw pairing approve whatsapp <code>` (list med `openclaw pairing list whatsapp`).
- Koder udløber efter 1 time; ventende anmodninger er begrænset til 3 pr. kanal.

**Kan flere personer bruge forskellige OpenClaw-instanser på ét WhatsApp-nummer?**  
Ja, ved at route hver afsender til en forskellig agent via `bindings` (peer `kind: "dm"`, afsender E.164 som `+15551234567`). Svar kommer stadig fra **samme WhatsApp-konto**, og direkte chats kollapser til hver agents hovedsession, så brug **én agent pr. person**. DM-adgangskontrol (`dmPolicy`/`allowFrom`) er global pr. WhatsApp-konto. Se [Multi-Agent Routing](/concepts/multi-agent).

**Hvorfor beder guiden om mit telefonnummer?**  
Guiden bruger det til at sætte din **tilladelsesliste/ejer**, så dine egne DM’er er tilladt. Det bruges ikke til automatisk afsendelse. Hvis du kører på dit personlige WhatsApp-nummer, så brug det samme nummer og aktivér `channels.whatsapp.selfChatMode`.

## Meddelelsesnormalisering (hvad modellen ser)

- `Body` er den aktuelle beskedtekst med konvolut.
- Citeret svar-kontekst **tilføjes altid**:

  ```
  [Replying to +1555 id:ABC123]
  <quoted text or <media:...>>
  [/Replying]
  ```

- Svarmetadata sættes også:
  - `ReplyToId` = stanzaId
  - `ReplyToBody` = citeret tekst eller medie-pladsholder
  - `ReplyToSender` = E.164 når kendt
- Indgående beskeder kun med medie bruger pladsholdere:
  - `<media:image|video|audio|document|sticker>`

## Grupper

- Grupper mappes til `agent:<agentId>:whatsapp:group:<jid>`-sessioner.
- Gruppepolitik: `channels.whatsapp.groupPolicy = open|disabled|allowlist` (standard `allowlist`).
- Aktiveringstilstande:
  - `mention` (standard): kræver @mention eller regex-match.
  - `always`: udløses altid.
- `/activation mention|always` er kun for ejer og skal sendes som en selvstændig besked.
- Ejer = `channels.whatsapp.allowFrom` (eller selv E.164 hvis ikke sat).
- **Historik-injektion** (kun afventende):
  - Seneste _ubehandlede_ beskeder (standard 50) indsættes under:
    `[Chat messages since your last reply - for context]` (beskeder, der allerede er i sessionen, genindsættes ikke)
  - Aktuel besked under:
    `[Current message - respond to this]`
  - Afsender-suffiks tilføjes: `[from: Name (+E164)]`
- Gruppemetadata caches i 5 min (emne + deltagere).

## Levering af svar (threading)

- WhatsApp Web sender standardbeskeder (ingen citeret-svar-threading i den nuværende gateway).
- Svar-tags ignoreres på denne kanal.

## Bekræftelsesreaktioner (auto-reager ved modtagelse)

WhatsApp kan automatisk sende emoji-reaktioner til indgående beskeder straks ved modtagelse, før botten genererer et svar. Dette giver øjeblikkelig feedback til brugere om, at deres besked er modtaget.

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

**Valgmuligheder:**

- `emoji` (string): Emoji til bekræftelse (fx "👀", "✅", "📨"). Tom eller udeladt = funktionen deaktiveret.
- `direct` (boolean, standard: `true`): Send reaktioner i direkte/DM-chats.
- `group` (string, standard: `"mentions"`): Gruppechat-adfærd:
  - `"always"`: Reagér på alle gruppebeskeder (selv uden @mention)
  - `"mentions"`: Reagér kun når botten er @mentioned
  - `"never"`: Reagér aldrig i grupper

**Pr.-konto-override:**

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

**Adfærdsnoter:**

- Reaktioner sendes **øjeblikkeligt** ved modtagelse af beskeden, før skriveindikatorer eller botsvar.
- I grupper med `requireMention: false` (aktivering: altid) vil `group: "mentions"` reagere på alle beskeder (ikke kun @mentions).
- Fire-and-forget: reaktionsfejl logges, men forhindrer ikke botten i at svare.
- Deltager-JID inkluderes automatisk for gruppereaktioner.
- WhatsApp ignorerer `messages.ackReaction`; brug `channels.whatsapp.ackReaction` i stedet.

## Agentværktøj (reaktioner)

- Værktøj: `whatsapp` med `react`-handling (`chatJid`, `messageId`, `emoji`, valgfrit `remove`).
- Valgfrit: `participant` (gruppeafsender), `fromMe` (reagere på din egen besked), `accountId` (multi-account).
- Semantik for fjernelse af reaktioner: se [/tools/reactions](/tools/reactions).
- Værktøjsgating: `channels.whatsapp.actions.reactions` (standard: aktiveret).

## Grænser

- Udgående tekst opdeles i bidder på `channels.whatsapp.textChunkLimit` (standard 4000).
- Valgfri linjeskifts-opdeling: sæt `channels.whatsapp.chunkMode="newline"` for at splitte på tomme linjer (afsnitsgrænser) før længdeopdeling.
- Indgående medie-gemninger er begrænset af `channels.whatsapp.mediaMaxMb` (standard 50 MB).
- Udgående medieelementer er begrænset af `agents.defaults.mediaMaxMb` (standard 5 MB).

## Udgående afsendelse (tekst + medier)

- Bruger aktiv web-lytter; fejl hvis gateway ikke kører.
- Tekstopdeling: maks. 4k pr. besked (konfigurerbar via `channels.whatsapp.textChunkLimit`, valgfrit `channels.whatsapp.chunkMode`).
- Medier:
  - Billede/video/lyd/dokument understøttet.
  - Lyd sendes som PTT; `audio/ogg` => `audio/ogg; codecs=opus`.
  - Undertekst kun på første medieelement.
  - Medie-fetch understøtter HTTP(S) og lokale stier.
  - Animerede GIF’er: WhatsApp forventer MP4 med `gifPlayback: true` for inline-loop.
    - CLI: `openclaw message send --media <mp4> --gif-playback`
    - Gateway: `send`-parametre inkluderer `gifPlayback: true`

## Stemmenoter (PTT-lyd)

WhatsApp sender lyd som **stemmenoter** (PTT-boble).

- Bedste resultater: OGG/Opus. OpenClaw omskriver `audio/ogg` til `audio/ogg; codecs=opus`.
- `[[audio_as_voice]]` ignoreres for WhatsApp (lyd sendes allerede som stemmenote).

## Mediegrænser + optimering

- Standard udgående grænse: 5 MB (pr. medieelement).
- Override: `agents.defaults.mediaMaxMb`.
- Billeder optimeres automatisk til JPEG under grænsen (resize + kvalitets-sweep).
- For store medier => fejl; mediesvar falder tilbage til tekstadvarsel.

## Heartbeats

- **Gateway-heartbeat** logger forbindelsestilstand (`web.heartbeatSeconds`, standard 60s).
- **Agent-heartbeat** kan konfigureres pr. agent (`agents.list[].heartbeat`) eller globalt
  via `agents.defaults.heartbeat` (fallback når der ikke er sat pr.-agent-poster).
  - Bruger den konfigurerede heartbeat-prompt (standard: `Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`) + `HEARTBEAT_OK` springe-adfærd.
  - Levering er som standard den senest brugte kanal (eller konfigureret mål).

## Genforbindelsesadfærd

- Backoff-politik: `web.reconnect`:
  - `initialMs`, `maxMs`, `factor`, `jitter`, `maxAttempts`.
- Hvis maxAttempts nås, stopper web-overvågning (degraderet).
- Logget ud => stop og kræv genlink.

## Konfigurations-hurtigkort

- `channels.whatsapp.dmPolicy` (DM-politik: parring/tilladelsesliste/åben/deaktiveret).
- `channels.whatsapp.selfChatMode` (samme-telefon-opsætning; botten bruger dit personlige WhatsApp-nummer).
- `channels.whatsapp.allowFrom` (DM-tilladelsesliste). WhatsApp bruger E.164-telefonnumre (ingen brugernavne).
- `channels.whatsapp.mediaMaxMb` (indgående medie-gemmegrænse).
- `channels.whatsapp.ackReaction` (auto-reaktion ved modtagelse af besked: `{emoji, direct, group}`).
- `channels.whatsapp.accounts.<accountId>.*` (pr.-konto-indstillinger + valgfrit `authDir`).
- `channels.whatsapp.accounts.<accountId>.mediaMaxMb` (pr.-konto indgående mediegrænse).
- `channels.whatsapp.accounts.<accountId>.ackReaction` (pr.-konto ack-reaktions-override).
- `channels.whatsapp.groupAllowFrom` (gruppeafsender-tilladelsesliste).
- `channels.whatsapp.groupPolicy` (gruppepolitik).
- `channels.whatsapp.historyLimit` / `channels.whatsapp.accounts.<accountId>.historyLimit` (gruppehistorik-kontekst; `0` deaktiverer).
- `channels.whatsapp.dmHistoryLimit` (DM-historikgrænse i brugerture). Pr.-bruger-override: `channels.whatsapp.dms["<phone>"].historyLimit`.
- `channels.whatsapp.groups` (gruppe-tilladelsesliste + mention-gating-standarder; brug `"*"` for at tillade alle)
- `channels.whatsapp.actions.reactions` (gate WhatsApp-værktøjsreaktioner).
- `agents.list[].groupChat.mentionPatterns` (eller `messages.groupChat.mentionPatterns`)
- `messages.groupChat.historyLimit`
- `channels.whatsapp.messagePrefix` (indgående præfiks; pr.-konto: `channels.whatsapp.accounts.<accountId>.messagePrefix`; forældet: `messages.messagePrefix`)
- `messages.responsePrefix` (udgående præfiks)
- `agents.defaults.mediaMaxMb`
- `agents.defaults.heartbeat.every`
- `agents.defaults.heartbeat.model` (valgfri override)
- `agents.defaults.heartbeat.target`
- `agents.defaults.heartbeat.to`
- `agents.defaults.heartbeat.session`
- `agents.list[].heartbeat.*` (pr.-agent-override)
- `session.*` (scope, idle, store, mainKey)
- `web.enabled` (deaktivér kanalstart når false)
- `web.heartbeatSeconds`
- `web.reconnect.*`

## Logs + fejlfinding

- Subsystemer: `whatsapp/inbound`, `whatsapp/outbound`, `web-heartbeat`, `web-reconnect`.
- Logfil: `/tmp/openclaw/openclaw-YYYY-MM-DD.log` (kan konfigureres).
- Fejlfindingsguide: [Gateway fejlfinding](/gateway/troubleshooting).

## Fejlfinding (hurtig)

**Ikke linket / QR-login kræves**

- Symptom: `channels status` viser `linked: false` eller advarer “Not linked”.
- Løsning: kør `openclaw channels login` på gateway-værten og scan QR (WhatsApp → Indstillinger → Forbundne enheder).

**Linket men frakoblet / genforbindelsesloop**

- Symptom: `channels status` viser `running, disconnected` eller advarer “Linked but disconnected”.
- Løsning: `openclaw doctor` (eller genstart gateway). Hvis det fortsætter, link igen via `channels login` og inspicér `openclaw logs --follow`.

**Bun-runtime**

- Bun er **ikke anbefalet**. WhatsApp (Baileys) og Telegram er upålidelige på Bun.
  Kør gateway med **Node**. (Se runtime-note i Kom godt i gang.)
