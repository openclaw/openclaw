---
summary: "Heartbeat-pollingberichten en notificatieregels"
read_when:
  - Het aanpassen van heartbeat-cadans of berichten
  - Beslissen tussen heartbeat en cron voor geplande taken
title: "Heartbeat"
---

# Heartbeat (Gateway)

> **Heartbeat vs Cron?** Zie [Cron vs Heartbeat](/automation/cron-vs-heartbeat) voor richtlijnen over wanneer je welke gebruikt.

Heartbeat voert **periodieke agent-beurten** uit in de hoofdsessie, zodat het model
alles kan signaleren dat aandacht nodig heeft zonder je te overspoelen.

Problemen oplossen: [/automation/troubleshooting](/automation/troubleshooting)

## Snelle start (beginner)

1. Laat heartbeats ingeschakeld (standaard is `30m`, of `1h` voor Anthropic OAuth/setup-token) of stel je eigen cadans in.
2. Maak een kleine `HEARTBEAT.md`-checklist in de agent-werkruimte (optioneel maar aanbevolen).
3. Bepaal waar heartbeat-berichten naartoe moeten (`target: "last"` is de standaard).
4. Optioneel: schakel levering van heartbeat-redenering in voor transparantie.
5. Optioneel: beperk heartbeats tot actieve uren (lokale tijd).

Voorbeeldconfiguratie:

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

## Standaardwaarden

- Interval: `30m` (of `1h` wanneer Anthropic OAuth/setup-token de gedetecteerde authenticatiemodus is). Stel `agents.defaults.heartbeat.every` in of per agent `agents.list[].heartbeat.every`; gebruik `0m` om uit te schakelen.
- Prompttekst (configureerbaar via `agents.defaults.heartbeat.prompt`):
  `Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`
- De heartbeat-prompt wordt **woordelijk** als gebruikersbericht verzonden. De systeem-
  prompt bevat een sectie “Heartbeat” en de run wordt intern gemarkeerd.
- Actieve uren (`heartbeat.activeHours`) worden gecontroleerd in de geconfigureerde tijdzone.
  Buiten het venster worden heartbeats overgeslagen tot de volgende tick binnen het venster.

## Waar de heartbeat-prompt voor dient

De standaardprompt is bewust breed:

- **Achtergrondtaken**: “Consider outstanding tasks” stimuleert de agent om
  openstaande opvolgingen (inbox, agenda, herinneringen, wachtrijen) te bekijken en
  alles urgents naar voren te brengen.
- **Menselijke check-in**: “Checkup sometimes on your human during day time” stimuleert
  een af en toe licht “heb je iets nodig?”-bericht, maar vermijdt nachtelijke spam
  door je geconfigureerde lokale tijdzone te gebruiken (zie [/concepts/timezone](/concepts/timezone)).

Als je wilt dat een heartbeat iets heel specifieks doet (bijv. “check Gmail PubSub-
statistieken” of “verifieer gateway-gezondheid”), stel dan `agents.defaults.heartbeat.prompt` (of
`agents.list[].heartbeat.prompt`) in op een aangepaste tekst (woordelijk verzonden).

## Responscontract

- Als er niets aandacht nodig heeft, antwoord met **`HEARTBEAT_OK`**.
- Tijdens heartbeat-runs behandelt OpenClaw `HEARTBEAT_OK` als een ack wanneer het
  aan het **begin of einde** van het antwoord verschijnt. De token wordt verwijderd
  en het antwoord wordt verworpen als de resterende inhoud **≤ `ackMaxChars`**
  (standaard: 300).
- Als `HEARTBEAT_OK` in het **midden** van een antwoord verschijnt, wordt het niet
  speciaal behandeld.
- Voor waarschuwingen **niet** `HEARTBEAT_OK` opnemen; retourneer alleen de
  waarschuwingstekst.

Buiten heartbeats wordt een losstaande `HEARTBEAT_OK` aan het begin/einde van een
bericht verwijderd en gelogd; een bericht dat alleen `HEARTBEAT_OK` is, wordt
verworpen.

## Config

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

### Reikwijdte en prioriteit

- `agents.defaults.heartbeat` stelt globaal heartbeat-gedrag in.
- `agents.list[].heartbeat` voegt hier bovenop samen; als een agent een `heartbeat`-blok
  heeft, draaien **alleen die agents** heartbeats.
- `channels.defaults.heartbeat` stelt zichtbaarheidsstandaarden in voor alle kanalen.
- `channels.<channel>.heartbeat` overschrijft kanaalstandaarden.
- `channels.<channel>.accounts.<id>.heartbeat` (kanalen met meerdere accounts) overschrijft per-kanaalinstellingen.

### Per-agent heartbeats

Als een `agents.list[]`-item een `heartbeat`-blok bevat, draaien **alleen die
agents** heartbeats. Het per-agent-blok wordt samengevoegd bovenop `agents.defaults.heartbeat`
(zodat je gedeelde standaardwaarden één keer kunt instellen en per agent kunt
overschrijven).

Voorbeeld: twee agents, alleen de tweede agent draait heartbeats.

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

### Voorbeeld actieve uren

Beperk heartbeats tot kantooruren in een specifieke tijdzone:

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

Buiten dit venster (vóór 9.00 of na 22.00 Eastern) worden heartbeats overgeslagen. De
volgende geplande tick binnen het venster wordt normaal uitgevoerd.

### Voorbeeld met meerdere accounts

Gebruik `accountId` om een specifiek account te targeten op kanalen met meerdere
accounts zoals Telegram:

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

### Veld notities

- `every`: heartbeat-interval (duurstring; standaardeenheid = minuten).
- `model`: optionele model-override voor heartbeat-runs (`provider/model`).
- `includeReasoning`: wanneer ingeschakeld, lever ook het aparte `Reasoning:`-bericht
  wanneer beschikbaar (zelfde vorm als `/reasoning on`).
- `session`: optionele sessiesleutel voor heartbeat-runs.
  - `main` (standaard): hoofdsessie van de agent.
  - Expliciete sessiesleutel (kopieer uit `openclaw sessions --json` of de [sessions CLI](/cli/sessions)).
  - Formaten van sessiesleutels: zie [Sessions](/concepts/session) en [Groups](/channels/groups).
- `target`:
  - `last` (standaard): lever aan het laatst gebruikte externe kanaal.
  - expliciet kanaal: `whatsapp` / `telegram` / `discord` /
    `googlechat` / `slack` / `msteams` / `signal` /
    `imessage`.
  - `none`: voer de heartbeat uit maar **lever niet extern**.
- `to`: optionele ontvanger-override (kanaalspecifieke id, bijv. E.164 voor
  WhatsApp of een Telegram-chat-id).
- `accountId`: optionele account-id voor kanalen met meerdere accounts. Wanneer
  `target: "last"`, geldt de account-id voor het opgeloste laatste kanaal als dat
  accounts ondersteunt; anders wordt deze genegeerd. Als de account-id niet overeen-
  komt met een geconfigureerd account voor het opgeloste kanaal, wordt levering
  overgeslagen.
- `prompt`: overschrijft de standaardprompttekst (niet samengevoegd).
- `ackMaxChars`: maximaal toegestane tekens na `HEARTBEAT_OK` vóór levering.
- `activeHours`: beperkt heartbeat-runs tot een tijdvenster. Object met
  `start` (HH:MM, inclusief), `end` (HH:MM exclusief;
  `24:00` toegestaan voor einde-van-de-dag), en optioneel `timezone`.
  - Weggelaten of `"user"`: gebruikt je `agents.defaults.userTimezone` indien ingesteld,
    anders valt het terug op de tijdzone van het hostsysteem.
  - `"local"`: gebruikt altijd de tijdzone van het hostsysteem.
  - Elke IANA-identificatie (bijv. `America/New_York`): direct gebruikt; bij ongeldig
    valt het terug op het `"user"`-gedrag hierboven.
  - Buiten het actieve venster worden heartbeats overgeslagen tot de volgende tick
    binnen het venster.

## Leveringsgedrag

- Heartbeats draaien standaard in de hoofdsessie van de agent (`agent:<id>:<mainKey>`),
  of `global` wanneer `session.scope = "global"`. Stel `session` in om te
  overschrijven naar een specifieke kanaalsessie (Discord/WhatsApp/etc.).
- `session` beïnvloedt alleen de runcontext; levering wordt geregeld door
  `target` en `to`.
- Om te leveren aan een specifiek kanaal/ontvanger, stel `target` +
  `to` in. Met `target: "last"` gebruikt levering het laatste externe
  kanaal voor die sessie.
- Als de hoofdqueue bezet is, wordt de heartbeat overgeslagen en later opnieuw
  geprobeerd.
- Als `target` naar geen externe bestemming resolveert, vindt de run nog
  steeds plaats maar wordt er geen uitgaand bericht verzonden.
- Alleen-heartbeat-antwoorden houden de sessie **niet** actief; de laatste
  `updatedAt` wordt hersteld zodat idle-verval normaal werkt.

## Zichtbaarheidsinstellingen

Standaard worden `HEARTBEAT_OK`-acknowledgments onderdrukt terwijl waarschuwings-
inhoud wordt geleverd. Je kunt dit per kanaal of per account aanpassen:

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

Prioriteit: per account → per kanaal → kanaalstandaarden → ingebouwde standaarden.

### Wat elke vlag doet

- `showOk`: verstuurt een `HEARTBEAT_OK`-acknowledgment wanneer het model een
  alleen-OK-antwoord retourneert.
- `showAlerts`: verstuurt de waarschuwingsinhoud wanneer het model een niet-OK-
  antwoord retourneert.
- `useIndicator`: genereert indicatorgebeurtenissen voor UI-statusoppervlakken.

Als **alle drie** false zijn, slaat OpenClaw de heartbeat-run volledig over (geen
modelaanroep).

### Voorbeelden per kanaal vs per account

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

### Veelvoorkomende patronen

| Doel                                                              | Config                                                                                   |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Standaardgedrag (stille OK's, alerts aan)      | _(geen configuratie nodig)_                                           |
| Volledig stil (geen berichten, geen indicator) | `channels.defaults.heartbeat: { showOk: false, showAlerts: false, useIndicator: false }` |
| Alleen indicator (geen berichten)              | `channels.defaults.heartbeat: { showOk: false, showAlerts: false, useIndicator: true }`  |
| OK's alleen in één kanaal                                         | `channels.telegram.heartbeat: { showOk: true }`                                          |

## HEARTBEAT.md (optioneel)

Als er een `HEARTBEAT.md`-bestand in de werkruimte bestaat, instrueert de
standaardprompt de agent om het te lezen. Zie het als je “heartbeat-checklist”:
klein, stabiel en veilig om elke 30 minuten op te nemen.

Als `HEARTBEAT.md` bestaat maar effectief leeg is (alleen lege regels en
markdown-koppen zoals `# Heading`), slaat OpenClaw de heartbeat-run over om
API-aanroepen te besparen.
Als het bestand ontbreekt, draait de heartbeat nog
steeds en beslist het model wat te doen.

Houd het klein (korte checklist of herinneringen) om prompt-opblazing te vermijden.

Voorbeeld `HEARTBEAT.md`:

```md
# Heartbeat checklist

- Quick scan: anything urgent in inboxes?
- If it’s daytime, do a lightweight check-in if nothing else is pending.
- If a task is blocked, write down _what is missing_ and ask Peter next time.
```

### Kan de agent HEARTBEAT.md bijwerken?

Ja — als je dat vraagt.

`HEARTBEAT.md` is gewoon een normaal bestand in de agent-werkruimte, dus je kunt
de agent (in een normale chat) iets zeggen als:

- “Werk `HEARTBEAT.md` bij om een dagelijkse agendacontrole toe te voegen.”
- “Herschrijf `HEARTBEAT.md` zodat het korter is en gericht op inbox-opvolging.”

Als je wilt dat dit proactief gebeurt, kun je ook een expliciete regel in je
heartbeat-prompt opnemen, zoals: “Als de checklist verouderd raakt, werk
HEARTBEAT.md bij met een betere.”

Veiligheidsnotitie: zet geen geheimen (API-sleutels, telefoonnummers, privé-tokens)
in `HEARTBEAT.md` — het wordt onderdeel van de promptcontext.

## Handmatige wake (on-demand)

Je kunt een systeemevent in de wachtrij plaatsen en een onmiddellijke heartbeat
triggeren met:

```bash
openclaw system event --text "Check for urgent follow-ups" --mode now
```

Als meerdere agents `heartbeat` hebben geconfigureerd, voert een handmatige wake
elk van die agent-heartbeats onmiddellijk uit.

Gebruik `--mode next-heartbeat` om te wachten op de volgende geplande tick.

## Levering van redenering (optioneel)

Standaard leveren heartbeats alleen de uiteindelijke “antwoord”-payload.

Als je transparantie wilt, schakel in:

- `agents.defaults.heartbeat.includeReasoning: true`

Wanneer ingeschakeld, leveren heartbeats ook een apart bericht met het voorvoegsel
`Reasoning:` (zelfde vorm als `/reasoning on`). Dit kan nuttig zijn wanneer de
agent meerdere sessies/codexen beheert en je wilt zien waarom hij besloot je te
pingen — maar het kan ook meer interne details lekken dan je wilt. Houd het
bij voorkeur uit in groepschats.

## Kostenbewustzijn

Heartbeats voeren volledige agent-beurten uit. Kortere intervallen verbruiken meer
tokens. Houd `HEARTBEAT.md` klein en overweeg een goedkoper `model` of
`target: "none"` als je alleen interne statusupdates wilt.
