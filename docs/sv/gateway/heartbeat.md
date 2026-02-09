---
summary: "Heartbeat-pollningsmeddelanden och notifieringsregler"
read_when:
  - Justera heartbeat-frekvens eller meddelanden
  - Välja mellan heartbeat och cron för schemalagda uppgifter
title: "Heartbeat"
---

# Heartbeat (Gateway)

> **Heartbeat vs Cron?** Se [Cron vs Heartbeat](/automation/cron-vs-heartbeat) för vägledning om när du ska använda respektive.

Heartbeat kör **periodiska agentvarv** i huvudsessionen så att modellen kan
lyfta fram sådant som behöver uppmärksamhet utan att spamma dig.

Felsökning: [/automation/troubleshooting](/automation/troubleshooting)

## Snabbstart (nybörjare)

1. Låt heartbeats vara aktiverade (standard är `30m`, eller `1h` för Anthropic OAuth/setup-token) eller ställ in din egen frekvens.
2. Skapa en liten `HEARTBEAT.md`-checklista i agentens arbetsyta (valfritt men rekommenderat).
3. Bestäm vart heartbeat-meddelanden ska skickas (`target: "last"` är standard).
4. Valfritt: aktivera leverans av heartbeat-resonemang för transparens.
5. Valfritt: begränsa heartbeats till aktiva timmar (lokal tid).

Exempel på konfig:

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

## Standardvärden

- Interval: `30m` (eller `1h` när Anthropic OAuth/setup-token är det detekterade auth läget). Ange `agents.defaults.heartbeat.every` eller per-agent `agents.list[].heartbeat.every`; använd `0m` för att inaktivera.
- Prompt kropp (konfigurerbar via `agents.defaults.heartbeat.prompt`):
  `Read HEARTBEAT.md om den existerar (arbetsytans sammanhang). Följ den strikt. Sluta inte eller upprepa gamla uppgifter från tidigare chattar. Om inget behöver uppmärksamhet, svara HEARTBEAT_OK.`
- Hjärtslag-prompten skickas **ordagrande** som användarmeddelande. Systemet
  prompten innehåller en “Heartbeat” sektion och körningen är flaggad internt.
- Aktiva timmar (`heartbeat.activeHours`) kontrolleras i den konfigurerade tidszonen.
  Utanför fönstret hoppas hjärtslag över till nästa fästing inne i fönstret.

## Vad heartbeat-prompten är till för

Standardprompten är avsiktligt bred:

- **Bakgrundsuppgifter**: ”Consider outstanding tasks” uppmanar agenten att granska
  uppföljningar (inkorg, kalender, påminnelser, köat arbete) och lyfta fram det som är brådskande.
- **Mänsklig avstämning**: ”Checkup sometimes on your human during day time” uppmuntrar
  till ett ibland förekommande lättviktigt ”behöver du något?”-meddelande, men undviker
  nattligt spam genom att använda din konfigurerade lokala tidszon (se [/concepts/timezone](/concepts/timezone)).

Om du vill att ett hjärtslag ska göra något mycket specifikt (t.ex. “kontrollera Gmail PubSub
statistik” eller “verifiera gateway hälsa”), ange `agents. efaults.heartbeat.prompt` (eller
`agents.list[].heartbeat.prompt`) till en anpassad kropp (skickad verbatim).

## Svarskontrakt

- Om inget kräver uppmärksamhet, svara med **`HEARTBEAT_OK`**.
- Under hjärtslag körs behandlar OpenClaw `HEARTBEAT_OK` som en ack när det visas
  vid **början eller slutet** av svaret. Talet är borttaget och svaret är
  tappat om det återstående innehållet är **≤ `ackMaxChars`** (standard: 300).
- Om `HEARTBEAT_OK` förekommer i **mitten** av ett svar behandlas den inte
  särskilt.
- För larm ska du **inte** inkludera `HEARTBEAT_OK`; returnera endast larmtexten.

Utanför heartbeats tas lösa `HEARTBEAT_OK` i början/slutet av ett meddelande bort
och loggas; ett meddelande som bara är `HEARTBEAT_OK` slängs.

## Konfig

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

### Omfattning och prioritet

- `agents.defaults.heartbeat` sätter globalt heartbeat-beteende.
- `agents.list[].heartbeat` slås samman ovanpå; om någon agent har ett `heartbeat`-block
  kör **endast dessa agenter** heartbeats.
- `channels.defaults.heartbeat` sätter synlighetsstandarder för alla kanaler.
- `kanaler.<channel>.heartbeat` åsidosätter kanalstandard.
- `kanaler.<channel>.accounts.<id>.heartbeat` (multi-account kanaler) åsidosätter inställningar per kanal.

### Per-agent-heartbeats

Om någon `agents.list[]` inlägg innehåller ett `heartbeat`-block, **bara de agenterna**
kör hjärtslag. Blocket per agent sammanfogas ovanpå `agents.defaults.heartbeat`
(så att du kan ställa in delade standardvärden en gång och åsidosätta per agent).

Exempel: två agenter, endast den andra agenten kör heartbeats.

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

### Exempel: aktiva timmar

Begränsa heartbeats till kontorstid i en specifik tidszon:

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

Utanför detta fönster (före 09:00 eller efter 22:00 östra), hoppas hjärtslag över. Nästa schemalagda bock inne i fönstret kommer att köras normalt.

### Exempel: flera konton

Använd `accountId` för att rikta in dig på ett specifikt konto i kanaler med flera
konton som Telegram:

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

### Fältnoteringar

- `every`: heartbeat-intervall (varaktighetssträng; standardenhet = minuter).
- `model`: valfri modellåsidosättning för heartbeat-körningar (`provider/model`).
- `includeReasoning`: när aktiverad, levererar även det separata `Reasoning:`-meddelandet
  när tillgängligt (samma form som `/reasoning on`).
- `session`: valfri sessionsnyckel för heartbeat-körningar.
  - `main` (standard): agentens huvudsession.
  - Explicit sessionsnyckel (kopiera från `openclaw sessions --json` eller [sessions CLI](/cli/sessions)).
  - Format för sessionsnycklar: se [Sessions](/concepts/session) och [Groups](/channels/groups).
- `target`:
  - `last` (standard): leverera till senast använda externa kanal.
  - Explicit kanal: `whatsapp` / `telegram` / `discord` / `googlechat` / `slack` / `msteams` / `signal` / `imessage`.
  - `none`: kör heartbeaten men **leverera inte** externt.
- `to`: valfri mottagare åsidosätter (kanalspecifikt id, t.ex. E.164 för WhatsApp eller ett Telegram chatt-id).
- `accountId`: valfritt kontonummer för kanaler med flera konton. När `target: "last"`, gäller konto-id för den lösta sista kanalen om den stöder konton; annars ignoreras. Om konto-id inte matchar ett konfigurerat konto för den lösta kanalen, hoppas leveransen över.
- `prompt`: åsidosätter standardpromptens text (slås inte samman).
- `ackMaxChars`: max antal tecken som tillåts efter `HEARTBEAT_OK` före leverans.
- `activeHours`: begränsar hjärtslag körs till ett tidsfönster. Objekt med `start` (HH:MM, inclusive), `end` (HH:MM exklusive; `24:00` tillåts för slut-av-dag) och valfri `timezone`.
  - Utelämnad eller `"user"`: använder din `agents.defaults.userTimezone` om den är satt,
    annars faller den tillbaka till värdsystemets tidszon.
  - `"local"`: använder alltid värdsystemets tidszon.
  - Någon IANA identifierare (t.ex. `America/New_York`): används direkt; om ogiltigt, faller tillbaka till `"användar"` beteende ovan.
  - Utanför det aktiva fönstret hoppas heartbeats över till nästa tick inom fönstret.

## Leveransbeteende

- Heartbeats körs i agentens huvudsession som standard (`agent:<id>:<mainKey>`),
  eller `global` när `session.scope = "global"`. Set `session` to override to a
  specific channel session (Discord/WhatsApp/etc.).
- `session` påverkar endast körningskontexten; leverans styrs av `target`
  och `to`.
- För att leverera till en specifik kanal / mottagare, sätt `target` + `to`. Med
  `target: "last"`, använder leverans den sista externa kanalen för den sessionen.
- Om huvudkön är upptagen hoppas heartbeaten över och försöks igen senare.
- Om `target` löses till ingen extern destination körs varvet ändå men inget
  utgående meddelande skickas.
- Endast-heartbeat-svar håller **inte** sessionen vid liv; den senaste `updatedAt`
  återställs så att inaktiv utgång beter sig normalt.

## Synlighetskontroller

Som standard undertrycks 'HEARTBEAT_OK' bekräftelser medan varningens innehåll är
levereras. Du kan justera detta per kanal eller per konto:

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

Prioritet: per konto → per kanal → kanalstandarder → inbyggda standarder.

### Vad varje flagga gör

- `showOk`: skickar en `HEARTBEAT_OK`-kvittens när modellen returnerar ett
  svar som endast är OK.
- `showAlerts`: skickar larm-innehållet när modellen returnerar ett icke-OK-svar.
- `useIndicator`: emitterar indikatorhändelser för UI-statusytor.

Om **alla tre** är falska hoppar OpenClaw över heartbeat-körningen helt (ingen modellanrop).

### Exempel: per kanal vs per konto

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

### Vanliga mönster

| Mål                                                              | Konfig                                                                                   |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Standardbeteende (tysta OK, larm på)          | _(ingen konfig behövs)_                                               |
| Helt tyst (inga meddelanden, ingen indikator) | `channels.defaults.heartbeat: { showOk: false, showAlerts: false, useIndicator: false }` |
| Endast indikator (inga meddelanden)           | `channels.defaults.heartbeat: { showOk: false, showAlerts: false, useIndicator: true }`  |
| OK i endast en kanal                                             | `channels.telegram.heartbeat: { showOk: true }`                                          |

## HEARTBEAT.md (valfritt)

Om en 'HEARTBEAT.md' fil finns i arbetsytan, säger standardprompten till
agenten att läsa den. Tänk på det som en ”hjärtslagschecklista”: liten, stabil och
säker att inkludera var 30:e minut.

Om `HEARTBEAT. d` finns men är effektivt tom (endast tomma rader och markdown
rubriker som `# Heading`), hoppar OpenClaw över hjärtslaget för att spara API-samtal.
Om filen saknas körs heartbeat ändå och modellen avgör vad som ska göras.

Håll den liten (kort checklista eller påminnelser) för att undvika prompt-svällning.

Exempel på `HEARTBEAT.md`:

```md
# Heartbeat checklist

- Quick scan: anything urgent in inboxes?
- If it’s daytime, do a lightweight check-in if nothing else is pending.
- If a task is blocked, write down _what is missing_ and ask Peter next time.
```

### Kan agenten uppdatera HEARTBEAT.md?

Ja — om du ber den.

`HEARTBEAT.md` är bara en vanlig fil i agentens arbetsyta, så du kan säga till
agenten (i en vanlig chatt) något som:

- ”Uppdatera `HEARTBEAT.md` för att lägga till en daglig kalenderkontroll.”
- ”Skriv om `HEARTBEAT.md` så att den blir kortare och fokuserad på inkorgsuppföljningar.”

Om du vill att detta ska ske proaktivt kan du även inkludera en explicit rad i din
heartbeat-prompt, till exempel: ”Om checklistan blir inaktuell, uppdatera
HEARTBEAT.md med en bättre.”

Säkerhetsnotering: lägg inte in hemligheter (API-nycklar, telefonnummer, privata
tokens) i `HEARTBEAT.md` — den blir en del av promptkontexten.

## Manuell väckning (on-demand)

Du kan köa en systemhändelse och trigga en omedelbar heartbeat med:

```bash
openclaw system event --text "Check for urgent follow-ups" --mode now
```

Om flera agenter har `heartbeat` konfigurerat kör en manuell väckning varje
agents heartbeat omedelbart.

Använd `--mode next-heartbeat` för att vänta på nästa schemalagda tick.

## Leverans av resonemang (valfritt)

Som standard levererar heartbeats endast den slutliga ”svar”-payloaden.

Om du vill ha transparens, aktivera:

- `agents.defaults.heartbeat.includeReasoning: true`

När aktiverad, kommer hjärtslag också att leverera ett separat meddelande prefixerat
`Anledning:` (samma form som `/resonemang på`). Detta kan vara användbart när agenten
hanterar flera sessioner/codexes och du vill se varför det bestämde sig för att pinga
du — men det kan också läcka mer intern detalj än du vill. Föredrar att hålla den
borta i gruppchattar.

## Kostnadsmedvetenhet

Heartbeats kör full agent varv. Kortare intervaller brinner fler tokens. Behåll
`HEARTBEAT.md` liten och överväg en billigare `modell` eller `target: "none"` om du
bara vill ha interna statusuppdateringar.
