---
summary: "Heartbeat-pollingmeddelelser og notifikationsregler"
read_when:
  - Justering af heartbeat-kadence eller beskeder
  - Valg mellem heartbeat og cron til planlagte opgaver
title: "Heartbeat"
x-i18n:
  source_path: gateway/heartbeat.md
  source_hash: e763caf86ef74488
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:42Z
---

# Heartbeat (Gateway)

> **Heartbeat vs Cron?** Se [Cron vs Heartbeat](/automation/cron-vs-heartbeat) for vejledning i, hvornår du skal bruge hvad.

Heartbeat kører **periodiske agent-turns** i hovedsessionen, så modellen kan
fremhæve alt, der kræver opmærksomhed, uden at spamme dig.

Fejlfinding: [/automation/troubleshooting](/automation/troubleshooting)

## Hurtig start (begynder)

1. Lad heartbeats være aktiveret (standard er `30m`, eller `1h` for Anthropic OAuth/setup-token), eller angiv din egen kadence.
2. Opret en lille `HEARTBEAT.md`-tjekliste i agentens workspace (valgfrit, men anbefalet).
3. Beslut, hvor heartbeat-meddelelser skal leveres (`target: "last"` er standard).
4. Valgfrit: aktivér levering af heartbeat-reasoning for gennemsigtighed.
5. Valgfrit: begræns heartbeats til aktive timer (lokal tid).

Eksempel på konfiguration:

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m",
        target: "last",
        // activeHours: { start: "08:00", end: "24:00" },
        // includeReasoning: true, // optional: send separate `Reasoning:` message too
      },
    },
  },
}
```

## Standardindstillinger

- Interval: `30m` (eller `1h`, når Anthropic OAuth/setup-token er den registrerede godkendelsestilstand). Sæt `agents.defaults.heartbeat.every` eller pr. agent `agents.list[].heartbeat.every`; brug `0m` for at deaktivere.
- Prompt-tekst (kan konfigureres via `agents.defaults.heartbeat.prompt`):
  `Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`
- Heartbeat-prompten sendes **ordret** som brugermeddelelse. Systemprompten
  indeholder en “Heartbeat”-sektion, og kørslen markeres internt.
- Aktive timer (`heartbeat.activeHours`) kontrolleres i den konfigurerede tidszone.
  Uden for vinduet springes heartbeats over indtil næste tick inden for vinduet.

## Hvad heartbeat-prompten er til

Standardprompten er bevidst bred:

- **Baggrundsopgaver**: “Consider outstanding tasks” giver agenten et puf til at gennemgå
  opfølgninger (indbakke, kalender, påmindelser, køarbejde) og fremhæve noget akut.
- **Menneskelig check-in**: “Checkup sometimes on your human during day time” giver et
  lejlighedsvist, let “har du brug for noget?”-budskab, men undgår natlig spam
  ved at bruge din konfigurerede lokale tidszone (se [/concepts/timezone](/concepts/timezone)).

Hvis du vil have, at et heartbeat gør noget meget specifikt (fx “check Gmail PubSub
stats” eller “verify gateway health”), så sæt `agents.defaults.heartbeat.prompt` (eller
`agents.list[].heartbeat.prompt`) til en brugerdefineret tekst (sendes ordret).

## Svar-kontrakt

- Hvis intet kræver opmærksomhed, svar med **`HEARTBEAT_OK`**.
- Under heartbeat-kørsler behandler OpenClaw `HEARTBEAT_OK` som en kvittering, når den
  vises ved **starten eller slutningen** af svaret. Tokenet fjernes, og svaret
  droppes, hvis det resterende indhold er **≤ `ackMaxChars`** (standard: 300).
- Hvis `HEARTBEAT_OK` vises **midt i** et svar, behandles det ikke særligt.
- For alarmer skal du **ikke** inkludere `HEARTBEAT_OK`; returnér kun alarmteksten.

Uden for heartbeats fjernes og logges tilfældige `HEARTBEAT_OK` ved start/slut af en
meddelelse; en meddelelse, der kun er `HEARTBEAT_OK`, droppes.

## Konfiguration

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m", // default: 30m (0m disables)
        model: "anthropic/claude-opus-4-6",
        includeReasoning: false, // default: false (deliver separate Reasoning: message when available)
        target: "last", // last | none | <channel id> (core or plugin, e.g. "bluebubbles")
        to: "+15551234567", // optional channel-specific override
        accountId: "ops-bot", // optional multi-account channel id
        prompt: "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.",
        ackMaxChars: 300, // max chars allowed after HEARTBEAT_OK
      },
    },
  },
}
```

### Omfang og prioritet

- `agents.defaults.heartbeat` sætter global heartbeat-adfærd.
- `agents.list[].heartbeat` flettes ovenpå; hvis en agent har en `heartbeat`-blok, kører **kun disse agenter** heartbeats.
- `channels.defaults.heartbeat` sætter synlighedsstandarder for alle kanaler.
- `channels.<channel>.heartbeat` tilsidesætter kanalstandarder.
- `channels.<channel>.accounts.<id>.heartbeat` (multi-account-kanaler) tilsidesætter pr.-kanal-indstillinger.

### Per-agent heartbeats

Hvis en `agents.list[]`-post indeholder en `heartbeat`-blok, kører **kun disse agenter**
heartbeats. Per-agent-blokken flettes ovenpå `agents.defaults.heartbeat`
(så du kan sætte fælles standarder én gang og tilsidesætte pr. agent).

Eksempel: to agenter, kun den anden agent kører heartbeats.

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m",
        target: "last",
      },
    },
    list: [
      { id: "main", default: true },
      {
        id: "ops",
        heartbeat: {
          every: "1h",
          target: "whatsapp",
          to: "+15551234567",
          prompt: "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.",
        },
      },
    ],
  },
}
```

### Eksempel på aktive timer

Begræns heartbeats til kontortid i en specifik tidszone:

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m",
        target: "last",
        activeHours: {
          start: "09:00",
          end: "22:00",
          timezone: "America/New_York", // optional; uses your userTimezone if set, otherwise host tz
        },
      },
    },
  },
}
```

Uden for dette vindue (før kl. 9 eller efter kl. 22 Eastern) springes heartbeats over. Næste planlagte tick inden for vinduet kører normalt.

### Eksempel med flere konti

Brug `accountId` til at målrette en specifik konto på multi-account-kanaler som Telegram:

```json5
{
  agents: {
    list: [
      {
        id: "ops",
        heartbeat: {
          every: "1h",
          target: "telegram",
          to: "12345678",
          accountId: "ops-bot",
        },
      },
    ],
  },
  channels: {
    telegram: {
      accounts: {
        "ops-bot": { botToken: "YOUR_TELEGRAM_BOT_TOKEN" },
      },
    },
  },
}
```

### Feltnoter

- `every`: heartbeat-interval (varighedsstreng; standardenhed = minutter).
- `model`: valgfri model-override for heartbeat-kørsler (`provider/model`).
- `includeReasoning`: når aktiveret, leveres også den separate `Reasoning:`-meddelelse, når den er tilgængelig (samme form som `/reasoning on`).
- `session`: valgfri sessionsnøgle for heartbeat-kørsler.
  - `main` (standard): agentens hovedsession.
  - Eksplicit sessionsnøgle (kopiér fra `openclaw sessions --json` eller [sessions CLI](/cli/sessions)).
  - Sessionsnøgleformater: se [Sessions](/concepts/session) og [Groups](/channels/groups).
- `target`:
  - `last` (standard): lever til den senest anvendte eksterne kanal.
  - Eksplicit kanal: `whatsapp` / `telegram` / `discord` / `googlechat` / `slack` / `msteams` / `signal` / `imessage`.
  - `none`: kør heartbeat, men **lever ikke** eksternt.
- `to`: valgfri modtager-override (kanalspecifikt id, fx E.164 for WhatsApp eller et Telegram-chat-id).
- `accountId`: valgfri konto-id for multi-account-kanaler. Når `target: "last"`, gælder konto-id’et for den løste sidste kanal, hvis den understøtter konti; ellers ignoreres det. Hvis konto-id’et ikke matcher en konfigureret konto for den løste kanal, springes levering over.
- `prompt`: tilsidesætter standard prompt-tekst (flettes ikke).
- `ackMaxChars`: maks. antal tegn tilladt efter `HEARTBEAT_OK` før levering.
- `activeHours`: begrænser heartbeat-kørsler til et tidsvindue. Objekt med `start` (HH:MM, inklusiv), `end` (HH:MM eksklusiv; `24:00` tilladt for slut-på-dagen) og valgfri `timezone`.
  - Udeladt eller `"user"`: bruger din `agents.defaults.userTimezone`, hvis sat, ellers falder tilbage til værtsystemets tidszone.
  - `"local"`: bruger altid værtsystemets tidszone.
  - Enhver IANA-identifikator (fx `America/New_York`): bruges direkte; hvis ugyldig, falder tilbage til `"user"`-adfærden ovenfor.
  - Uden for det aktive vindue springes heartbeats over indtil næste tick inden for vinduet.

## Leveringsadfærd

- Heartbeats kører som standard i agentens hovedsession (`agent:<id>:<mainKey>`),
  eller `global`, når `session.scope = "global"`. Sæt `session` for at tilsidesætte til en
  specifik kanalsession (Discord/WhatsApp/etc.).
- `session` påvirker kun kørselskonteksten; levering styres af `target` og `to`.
- For levering til en specifik kanal/modtager, sæt `target` + `to`. Med
  `target: "last"` bruger leveringen den sidste eksterne kanal for den session.
- Hvis hovedkøen er optaget, springes heartbeats over og forsøges igen senere.
- Hvis `target` ikke kan løses til en ekstern destination, sker kørslen stadig, men
  der sendes ingen udgående meddelelse.
- Heartbeat-only-svar holder **ikke** sessionen i live; den sidste `updatedAt`
  gendannes, så inaktiv udløb opfører sig normalt.

## Synlighedskontroller

Som standard undertrykkes `HEARTBEAT_OK`-kvitteringer, mens alarmindhold leveres.
Du kan justere dette pr. kanal eller pr. konto:

```yaml
channels:
  defaults:
    heartbeat:
      showOk: false # Hide HEARTBEAT_OK (default)
      showAlerts: true # Show alert messages (default)
      useIndicator: true # Emit indicator events (default)
  telegram:
    heartbeat:
      showOk: true # Show OK acknowledgments on Telegram
  whatsapp:
    accounts:
      work:
        heartbeat:
          showAlerts: false # Suppress alert delivery for this account
```

Prioritet: pr. konto → pr. kanal → kanalstandarder → indbyggede standarder.

### Hvad hvert flag gør

- `showOk`: sender en `HEARTBEAT_OK`-kvittering, når modellen returnerer et svar kun med OK.
- `showAlerts`: sender alarmindholdet, når modellen returnerer et ikke-OK-svar.
- `useIndicator`: udsender indikatorhændelser til UI-statusflader.

Hvis **alle tre** er false, springer OpenClaw heartbeat-kørslen helt over (ingen modelkald).

### Eksempler: pr. kanal vs. pr. konto

```yaml
channels:
  defaults:
    heartbeat:
      showOk: false
      showAlerts: true
      useIndicator: true
  slack:
    heartbeat:
      showOk: true # all Slack accounts
    accounts:
      ops:
        heartbeat:
          showAlerts: false # suppress alerts for the ops account only
  telegram:
    heartbeat:
      showOk: true
```

### Almindelige mønstre

| Mål                                           | Konfiguration                                                                            |
| --------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Standardadfærd (stille OK’er, alarmer)        | _(ingen konfiguration nødvendig)_                                                        |
| Helt stille (ingen beskeder, ingen indikator) | `channels.defaults.heartbeat: { showOk: false, showAlerts: false, useIndicator: false }` |
| Kun indikator (ingen beskeder)                | `channels.defaults.heartbeat: { showOk: false, showAlerts: false, useIndicator: true }`  |
| OK’er i kun én kanal                          | `channels.telegram.heartbeat: { showOk: true }`                                          |

## HEARTBEAT.md (valgfrit)

Hvis der findes en `HEARTBEAT.md`-fil i workspace, fortæller standardprompten
agenten, at den skal læse den. Tænk på den som din “heartbeat-tjekliste”: lille, stabil
og sikker at inkludere hver 30. minut.

Hvis `HEARTBEAT.md` findes, men reelt er tom (kun tomme linjer og markdown-headere
som `# Heading`), springer OpenClaw heartbeat-kørslen over for at spare API-kald.
Hvis filen mangler, kører heartbeat stadig, og modellen beslutter, hvad der skal gøres.

Hold den lille (kort tjekliste eller påmindelser) for at undgå prompt-bloat.

Eksempel på `HEARTBEAT.md`:

```md
# Heartbeat checklist

- Quick scan: anything urgent in inboxes?
- If it’s daytime, do a lightweight check-in if nothing else is pending.
- If a task is blocked, write down _what is missing_ and ask Peter next time.
```

### Kan agenten opdatere HEARTBEAT.md?

Ja — hvis du beder den om det.

`HEARTBEAT.md` er bare en almindelig fil i agentens workspace, så du kan sige til
agenten (i en normal chat) noget i stil med:

- “Opdatér `HEARTBEAT.md` for at tilføje et dagligt kalender-tjek.”
- “Omskriv `HEARTBEAT.md`, så den er kortere og fokuseret på opfølgninger i indbakken.”

Hvis du vil have, at dette sker proaktivt, kan du også inkludere en eksplicit linje i
din heartbeat-prompt som: “Hvis tjeklisten bliver forældet, så opdatér HEARTBEAT.md
med en bedre.”

Sikkerhedsnote: læg ikke hemmeligheder (API-nøgler, telefonnumre, private tokens) i
`HEARTBEAT.md` — den bliver en del af prompt-konteksten.

## Manuel vækning (on-demand)

Du kan enqueue en systemhændelse og udløse et øjeblikkeligt heartbeat med:

```bash
openclaw system event --text "Check for urgent follow-ups" --mode now
```

Hvis flere agenter har `heartbeat` konfigureret, kører en manuel vækning hver af
disse agent-heartbeats med det samme.

Brug `--mode next-heartbeat` for at vente på næste planlagte tick.

## Levering af reasoning (valgfrit)

Som standard leverer heartbeats kun den endelige “svar”-payload.

Hvis du ønsker gennemsigtighed, så aktivér:

- `agents.defaults.heartbeat.includeReasoning: true`

Når det er aktiveret, vil heartbeats også levere en separat meddelelse med præfikset
`Reasoning:` (samme form som `/reasoning on`). Dette kan være nyttigt, når agenten
styrer flere sessioner/codexes, og du vil se, hvorfor den besluttede at pinge dig —
men det kan også lække flere interne detaljer, end du ønsker. Foretræk at holde det
slået fra i gruppechats.

## Omkostningsbevidsthed

Heartbeats kører fulde agent-turns. Kortere intervaller bruger flere tokens. Hold
`HEARTBEAT.md` lille, og overvej en billigere `model` eller `target: "none"`, hvis du
kun ønsker interne statusopdateringer.
