---
summary: "Richtlijnen voor het kiezen tussen heartbeat en cron-jobs voor automatisering"
read_when:
  - Beslissen hoe terugkerende taken te plannen
  - Achtergrondmonitoring of notificaties instellen
  - Tokengebruik optimaliseren voor periodieke controles
title: "Cron vs Heartbeat"
---

# Cron vs Heartbeat: Wanneer gebruik je welke

Zowel heartbeats als cron-jobs laten je taken volgens een schema uitvoeren. Deze gids helpt je het juiste mechanisme te kiezen voor jouw use case.

## Snelle beslisgids

| Use case                                          | Aanbevolen                             | Waarom                                     |
| ------------------------------------------------- | -------------------------------------- | ------------------------------------------ |
| Inbox elke 30 min controleren                     | Heartbeat                              | Bundelt met andere checks, contextbewust   |
| Dagelijks rapport om 9:00 precies | Cron (geïsoleerd)   | Exacte timing nodig                        |
| Agenda monitoren op aankomende events             | Heartbeat                              | Natuurlijke fit voor periodiek bewustzijn  |
| Wekelijkse diepgaande analyse                     | Cron (geïsoleerd)   | Losstaande taak, kan ander model gebruiken |
| Herinner me over 20 minuten                       | Cron (main, `--at`) | Eenmalig met precieze timing               |
| Achtergrond check projectgezondheid               | Heartbeat                              | Lift mee op bestaande cyclus               |

## Heartbeat: Periodiek bewustzijn

Heartbeats draaien in de **main sessie** met een vaste interval (standaard: 30 min). Ze zijn ontworpen zodat de agent zaken kan nalopen en alles wat belangrijk is kan signaleren.

### Wanneer heartbeat gebruiken

- **Meerdere periodieke checks**: In plaats van 5 losse cron-jobs die inbox, agenda, weer, notificaties en projectstatus checken, kan één heartbeat dit allemaal bundelen.
- **Contextbewuste beslissingen**: De agent heeft volledige main-sessiecontext en kan dus slim bepalen wat urgent is en wat kan wachten.
- **Conversationele continuïteit**: Heartbeat-runs delen dezelfde sessie, waardoor de agent recente gesprekken onthoudt en natuurlijk kan opvolgen.
- **Monitoring met lage overhead**: Eén heartbeat vervangt veel kleine pollingtaken.

### Voordelen van heartbeat

- **Bundelt meerdere checks**: Eén agent-beurt kan inbox, agenda en notificaties samen bekijken.
- **Vermindert API-calls**: Eén heartbeat is goedkoper dan 5 geïsoleerde cron-jobs.
- **Contextbewust**: De agent weet waar je mee bezig bent en kan daarop prioriteren.
- **Slimme onderdrukking**: Als er niets is dat aandacht vraagt, antwoordt de agent `HEARTBEAT_OK` en wordt er geen bericht afgeleverd.
- **Natuurlijke timing**: Wijkt licht af op basis van wachtrijbelasting, wat voor de meeste monitoring prima is.

### Heartbeat-voorbeeld: HEARTBEAT.md-checklist

```md
# Heartbeat checklist

- Check email for urgent messages
- Review calendar for events in next 2 hours
- If a background task finished, summarize results
- If idle for 8+ hours, send a brief check-in
```

De agent leest dit bij elke heartbeat en handelt alle items in één beurt af.

### Heartbeat configureren

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m", // interval
        target: "last", // where to deliver alerts
        activeHours: { start: "08:00", end: "22:00" }, // optional
      },
    },
  },
}
```

Zie [Heartbeat](/gateway/heartbeat) voor de volledige configuratie.

## Cron: Precieze planning

Cron-jobs draaien op **exacte tijden** en kunnen in geïsoleerde sessies draaien zonder de main context te beïnvloeden.

### Wanneer cron gebruiken

- **Exacte timing vereist**: “Stuur dit elke maandag om 9:00” (niet “ongeveer rond 9”).
- **Losstaande taken**: Taken die geen conversationele context nodig hebben.
- **Ander model/denkwerk**: Zware analyses die een krachtiger model rechtvaardigen.
- **Eenmalige herinneringen**: “Herinner me over 20 minuten” met `--at`.
- **Luidruchtige/frequente taken**: Taken die de geschiedenis van de main sessie zouden vervuilen.
- **Externe triggers**: Taken die onafhankelijk moeten draaien van of de agent anders actief is.

### Voordelen van cron

- **Exacte timing**: 5-veld cron-expressies met tijdzone-ondersteuning.
- **Sessiescheiding**: Draait in `cron:<jobId>` zonder de main-geschiedenis te vervuilen.
- **Model overrides**: Gebruik per job een goedkoper of krachtiger model.
- **Afleveringscontrole**: Geïsoleerde jobs staan standaard op `announce` (samenvatting); kies `none` indien nodig.
- **Directe aflevering**: Announce-modus post direct zonder op een heartbeat te wachten.
- **Geen agentcontext nodig**: Draait zelfs als de main sessie idle of gecomprimeerd is.
- **Ondersteuning voor eenmalig**: `--at` voor precieze toekomstige tijdstempels.

### Cron-voorbeeld: Dagelijkse ochtendbriefing

```bash
openclaw cron add \
  --name "Morning briefing" \
  --cron "0 7 * * *" \
  --tz "America/New_York" \
  --session isolated \
  --message "Generate today's briefing: weather, calendar, top emails, news summary." \
  --model opus \
  --announce \
  --channel whatsapp \
  --to "+15551234567"
```

Dit draait exact om 7:00 uur New York-tijd, gebruikt Opus voor kwaliteit en kondigt direct een samenvatting aan op WhatsApp.

### Cron-voorbeeld: Eenmalige herinnering

```bash
openclaw cron add \
  --name "Meeting reminder" \
  --at "20m" \
  --session main \
  --system-event "Reminder: standup meeting starts in 10 minutes." \
  --wake now \
  --delete-after-run
```

Zie [Cron jobs](/automation/cron-jobs) voor de volledige CLI-referentie.

## Beschrijfdiagram

```
Does the task need to run at an EXACT time?
  YES -> Use cron
  NO  -> Continue...

Does the task need isolation from main session?
  YES -> Use cron (isolated)
  NO  -> Continue...

Can this task be batched with other periodic checks?
  YES -> Use heartbeat (add to HEARTBEAT.md)
  NO  -> Use cron

Is this a one-shot reminder?
  YES -> Use cron with --at
  NO  -> Continue...

Does it need a different model or thinking level?
  YES -> Use cron (isolated) with --model/--thinking
  NO  -> Use heartbeat
```

## Beide combineren

De meest efficiënte setup gebruikt **beide**:

1. **Heartbeat** verzorgt routinematige monitoring (inbox, agenda, notificaties) in één gebundelde beurt elke 30 minuten.
2. **Cron** verzorgt precieze schema’s (dagelijkse rapporten, wekelijkse reviews) en eenmalige herinneringen.

### Voorbeeld: Efficiënte automatiseringssetup

**HEARTBEAT.md** (elke 30 min gecontroleerd):

```md
# Heartbeat checklist

- Scan inbox for urgent emails
- Check calendar for events in next 2h
- Review any pending tasks
- Light check-in if quiet for 8+ hours
```

**Cron-jobs** (precieze timing):

```bash
# Daily morning briefing at 7am
openclaw cron add --name "Morning brief" --cron "0 7 * * *" --session isolated --message "..." --announce

# Weekly project review on Mondays at 9am
openclaw cron add --name "Weekly review" --cron "0 9 * * 1" --session isolated --message "..." --model opus

# One-shot reminder
openclaw cron add --name "Call back" --at "2h" --session main --system-event "Call back the client" --wake now
```

## Lobster: Deterministische workflows met goedkeuringen

Lobster is de workflow-runtime voor **multi-step tool-pipelines** die deterministische uitvoering en expliciete goedkeuringen nodig hebben.
Gebruik dit wanneer de taak meer is dan één agent-beurt en je een hervatbare workflow met menselijke checkpoints wilt.

### Wanneer Lobster past

- **Multi-step automatisering**: Je hebt een vaste pipeline van tool-calls nodig, geen eenmalige prompt.
- **Goedkeuringspoorten**: Bijwerkingen moeten pauzeren tot je goedkeurt en daarna hervatten.
- **Hervatbare runs**: Ga verder met een gepauzeerde workflow zonder eerdere stappen opnieuw uit te voeren.

### Hoe het samenwerkt met heartbeat en cron

- **Heartbeat/cron** bepalen _wanneer_ een run plaatsvindt.
- **Lobster** definieert _welke stappen_ plaatsvinden zodra de run start.

Voor geplande workflows gebruik je cron of heartbeat om een agent-beurt te triggeren die Lobster aanroept.
Voor ad-hoc workflows roep je Lobster direct aan.

### Operationele notities (uit de code)

- Lobster draait als een **lokale subprocess** (`lobster` CLI) in tool-modus en retourneert een **JSON-envelop**.
- Als de tool `needs_approval` retourneert, hervat je met een `resumeToken` en de `approve` vlag.
- De tool is een **optionele plugin**; schakel deze additief in via `tools.alsoAllow: ["lobster"]` (aanbevolen).
- Als je `lobsterPath` doorgeeft, moet dit een **absoluut pad** zijn.

Zie [Lobster](/tools/lobster) voor volledig gebruik en voorbeelden.

## Main sessie vs geïsoleerde sessie

Zowel heartbeat als cron kunnen met de main sessie interageren, maar op verschillende manieren:

|          | Heartbeat                          | Cron (main)             | Cron (geïsoleerd)                 |
| -------- | ---------------------------------- | ------------------------------------------ | ---------------------------------------------------- |
| Sessie   | Main                               | Main (via system event) | `cron:<jobId>`                                       |
| Historie | Gedeeld                            | Gedeeld                                    | Elke run fris                                        |
| Context  | Volledig                           | Volledig                                   | Geen (start schoon)               |
| Model    | Main-sessiemodel                   | Main-sessiemodel                           | Kan overriden                                        |
| Uitvoer  | Afgeleverd als niet `HEARTBEAT_OK` | Heartbeat-prompt + event                   | Announce-samenvatting (standaard) |

### Wanneer cron in de main sessie gebruiken

Gebruik `--session main` met `--system-event` wanneer je wilt:

- Dat de herinnering/het event in de main-sessiecontext verschijnt
- Dat de agent dit tijdens de volgende heartbeat met volledige context afhandelt
- Geen aparte geïsoleerde run

```bash
openclaw cron add \
  --name "Check project" \
  --every "4h" \
  --session main \
  --system-event "Time for a project health check" \
  --wake now
```

### Wanneer geïsoleerde cron gebruiken

Gebruik `--session isolated` wanneer je wilt:

- Een schone lei zonder eerdere context
- Andere model- of denk-instellingen
- Samenvattingen direct naar een kanaal aankondigen
- Historie die de main sessie niet vervuilt

```bash
openclaw cron add \
  --name "Deep analysis" \
  --cron "0 6 * * 0" \
  --session isolated \
  --message "Weekly codebase analysis..." \
  --model opus \
  --thinking high \
  --announce
```

## Kostenoverwegingen

| Mechanisme                           | Kostenprofiel                                                                      |
| ------------------------------------ | ---------------------------------------------------------------------------------- |
| Heartbeat                            | Eén beurt elke N minuten; schaalt met HEARTBEAT.md-grootte         |
| Cron (main)       | Voegt event toe aan volgende heartbeat (geen geïsoleerde beurt) |
| Cron (geïsoleerd) | Volledige agent-beurt per job; kan goedkoper model gebruiken                       |

**Tips**:

- Houd `HEARTBEAT.md` klein om token-overhead te minimaliseren.
- Bundel vergelijkbare checks in heartbeat in plaats van meerdere cron-jobs.
- Gebruik `target: "none"` op heartbeat als je alleen interne verwerking wilt.
- Gebruik geïsoleerde cron met een goedkoper model voor routinetaken.

## Gerelateerd

- [Heartbeat](/gateway/heartbeat) - volledige heartbeat-configuratie
- [Cron jobs](/automation/cron-jobs) - volledige cron CLI- en API-referentie
- [System](/cli/system) - system events + heartbeat-bediening
