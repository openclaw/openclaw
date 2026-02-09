---
summary: "Vägledning för att välja mellan heartbeat och cron-jobb för automatisering"
read_when:
  - När du avgör hur återkommande uppgifter ska schemaläggas
  - När du sätter upp bakgrundsövervakning eller aviseringar
  - När du optimerar tokenanvändning för periodiska kontroller
title: "Cron vs Heartbeat"
---

# Cron vs Heartbeat: När du ska använda vad

Både hjärtslag och cron-jobb låter dig köra uppgifter på ett schema. Denna guide hjälper dig att välja rätt mekanism för ditt användningsfall.

## Snabb beslutshjälp

| Användningsfall                                     | Rekommenderat                          | Varför                                        |
| --------------------------------------------------- | -------------------------------------- | --------------------------------------------- |
| Kontrollera inkorgen var 30:e minut | Heartbeat                              | Batchas med andra kontroller, kontextmedvetet |
| Skicka daglig rapport kl. 9 exakt   | Cron (isolated)     | Exakt timing krävs                            |
| Övervaka kalendern för kommande händelser           | Heartbeat                              | Naturlig passform för periodisk medvetenhet   |
| Köra veckovis djupanalys                            | Cron (isolated)     | Fristående uppgift, kan använda annan modell  |
| Påminn mig om 20 minuter                            | Cron (main, `--at`) | Engångsuppgift med exakt timing               |
| Bakgrundskontroll av projekthälsa                   | Heartbeat                              | Åker snålskjuts på befintlig cykel            |

## Heartbeat: Periodisk medvetenhet

Hjärtslag körs i **huvudsessionen** med ett regelbundet intervall (standard: 30 min). De är utformade för agenten att kontrollera saker och yta allt viktigt.

### När du ska använda heartbeat

- **Flera periodiska kontroller**: I stället för 5 separata cron-jobb som kontrollerar inkorg, kalender, väder, aviseringar och projektstatus kan en enda heartbeat batcha allt detta.
- **Kontextmedvetna beslut**: Agenten har full kontext från huvudsessionen och kan göra smarta bedömningar av vad som är brådskande respektive kan vänta.
- **Samtalskontinuitet**: Heartbeat-körningar delar samma session, så agenten minns nyliga samtal och kan följa upp naturligt.
- **Övervakning med låg overhead**: En heartbeat ersätter många små pollande uppgifter.

### Fördelar med heartbeat

- **Batchar flera kontroller**: Ett agentvarv kan granska inkorg, kalender och aviseringar tillsammans.
- **Minskar API-anrop**: En enda heartbeat är billigare än 5 isolerade cron-jobb.
- **Kontextmedveten**: Agenten vet vad du har arbetat med och kan prioritera därefter.
- **Smart undertryckning**: Om inget kräver uppmärksamhet svarar agenten `HEARTBEAT_OK` och inget meddelande levereras.
- **Naturlig timing**: Driver något beroende på köbelastning, vilket är okej för de flesta övervakningar.

### Heartbeat-exempel: HEARTBEAT.md-checklista

```md
# Heartbeat checklist

- Check email for urgent messages
- Review calendar for events in next 2 hours
- If a background task finished, summarize results
- If idle for 8+ hours, send a brief check-in
```

Agenten läser detta vid varje heartbeat och hanterar alla punkter i ett enda varv.

### Konfigurera heartbeat

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

Se [Heartbeat](/gateway/heartbeat) för fullständig konfiguration.

## Cron: Precis schemaläggning

Cron-jobb körs vid **exakta tider** och kan köras i isolerade sessioner utan att påverka huvudkontexten.

### När du ska använda cron

- **Exakt timing krävs**: ”Skicka detta kl. 9:00 varje måndag” (inte ”någon gång runt 9”).
- **Fristående uppgifter**: Uppgifter som inte behöver samtalskontext.
- **Annan modell/tänkande**: Tung analys som motiverar en kraftfullare modell.
- **Engångspåminnelser**: ”Påminn mig om 20 minuter” med `--at`.
- **Stökiga/frekventa uppgifter**: Uppgifter som skulle skräpa ned huvudsessionens historik.
- **Externa triggers**: Uppgifter som ska köras oberoende av om agenten annars är aktiv.

### Fördelar med cron

- **Exakt timing**: 5-fälts cron-uttryck med stöd för tidszoner.
- **Sessionsisolering**: Körs i `cron:<jobId>` utan att förorena huvudhistoriken.
- **Modellöverskrivningar**: Använd en billigare eller kraftfullare modell per jobb.
- **Leveranskontroll**: Isolerade jobb använder som standard `announce` (sammanfattning); välj `none` vid behov.
- **Omedelbar leverans**: Announce-läget publicerar direkt utan att vänta på heartbeat.
- **Ingen agentkontext krävs**: Körs även om huvudsessionen är inaktiv eller komprimerad.
- **Stöd för engångskörning**: `--at` för exakta framtida tidsstämplar.

### Cron-exempel: Daglig morgonbriefing

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

Detta körs exakt kl. 7:00 New York-tid, använder Opus för kvalitet och annonserar en sammanfattning direkt till WhatsApp.

### Cron-exempel: Engångspåminnelse

```bash
openclaw cron add \
  --name "Meeting reminder" \
  --at "20m" \
  --session main \
  --system-event "Reminder: standup meeting starts in 10 minutes." \
  --wake now \
  --delete-after-run
```

Se [Cron jobs](/automation/cron-jobs) för fullständig CLI-referens.

## Beslutsflödesschema

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

## Kombinera båda

Den mest effektiva uppsättningen använder **båda**:

1. **Heartbeat** hanterar rutinövervakning (inkorg, kalender, aviseringar) i ett batchat varv var 30:e minut.
2. **Cron** hanterar exakta scheman (dagliga rapporter, veckovisa genomgångar) och engångspåminnelser.

### Exempel: Effektiv automationsuppsättning

**HEARTBEAT.md** (kontrolleras var 30:e minut):

```md
# Heartbeat checklist

- Scan inbox for urgent emails
- Check calendar for events in next 2h
- Review any pending tasks
- Light check-in if quiet for 8+ hours
```

**Cron-jobb** (exakt timing):

```bash
# Daily morning briefing at 7am
openclaw cron add --name "Morning brief" --cron "0 7 * * *" --session isolated --message "..." --announce

# Weekly project review on Mondays at 9am
openclaw cron add --name "Weekly review" --cron "0 9 * * 1" --session isolated --message "..." --model opus

# One-shot reminder
openclaw cron add --name "Call back" --at "2h" --session main --system-event "Call back the client" --wake now
```

## Lobster: Deterministiska arbetsflöden med godkännanden

Hummer är arbetsflödets körtid för **flerstegs verktygsrörledningar** som behöver deterministisk exekvering och uttryckliga godkännanden.
Använd det när uppgiften är mer än en enda agent tur, och du vill ha ett återupptagbart arbetsflöde med mänskliga kontrollpunkter.

### När Lobster passar

- **Flerstegsautomatisering**: Du behöver en fast pipeline av verktygsanrop, inte en engångsprompt.
- **Godkännandegrindar**: Bieffekter ska pausas tills du godkänner, och sedan återupptas.
- **Återupptagbara körningar**: Fortsätt ett pausat arbetsflöde utan att köra om tidigare steg.

### Hur den samspelar med heartbeat och cron

- **Heartbeat/cron** avgör _när_ en körning sker.
- **Lobster** definierar _vilka steg_ som sker när körningen startar.

För schemalagda arbetsflöden, använd cron eller hjärtslag för att utlösa en agent tur som kallar Lobster.
För ad-hoc arbetsflöden, ring Hummer direkt.

### Operativa noteringar (från koden)

- Lobster körs som en **lokal underprocess** (`lobster` CLI) i verktygsläge och returnerar ett **JSON-kuvert**.
- Om verktyget returnerar `needs_approval` återupptar du med en `resumeToken` och flaggan `approve`.
- Verktyget är ett **valfritt plugin**; aktivera det additivt via `tools.alsoAllow: ["lobster"]` (rekommenderas).
- Om du skickar `lobsterPath` måste det vara en **absolut sökväg**.

Se [Lobster](/tools/lobster) för fullständig användning och exempel.

## Huvudsession vs Isolerad session

Både heartbeat och cron kan interagera med huvudsessionen, men på olika sätt:

|          | Heartbeat                        | Cron (main)                | Cron (isolated)                     |
| -------- | -------------------------------- | --------------------------------------------- | ------------------------------------------------------ |
| Session  | Huvud                            | Huvud (via systemhändelse) | `cron:<jobId>`                                         |
| Historik | Delad                            | Delad                                         | Ny vid varje körning                                   |
| Kontext  | Full                             | Full                                          | Ingen (startar rent)                |
| Modell   | Huvudsessionens modell           | Huvudsessionens modell                        | Kan överskrivas                                        |
| Utdata   | Levereras om inte `HEARTBEAT_OK` | Heartbeat-prompt + händelse                   | Annonsera sammanfattning (standard) |

### När du ska använda main-session-cron

Använd `--session main` med `--system-event` när du vill:

- Att påminnelsen/händelsen ska visas i huvudsessionens kontext
- Att agenten ska hantera den under nästa heartbeat med full kontext
- Ingen separat isolerad körning

```bash
openclaw cron add \
  --name "Check project" \
  --every "4h" \
  --session main \
  --system-event "Time for a project health check" \
  --wake now
```

### När du ska använda isolerad cron

Använd `--session isolated` när du vill:

- En ren start utan tidigare kontext
- Annan modell eller tänkandeinställningar
- Annonsera sammanfattningar direkt till en kanal
- Historik som inte skräpar ned huvudsessionen

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

## Kostnadsöverväganden

| Mekanism                           | Kostnadsprofil                                                                          |
| ---------------------------------- | --------------------------------------------------------------------------------------- |
| Heartbeat                          | Ett varv var N:e minut; skalar med HEARTBEAT.md-storlek |
| Cron (main)     | Lägger till händelse till nästa heartbeat (ingen isolerad körning)   |
| Cron (isolated) | Fullt agentvarv per jobb; kan använda billigare modell                                  |

**Tips**:

- Håll `HEARTBEAT.md` liten för att minimera token-overhead.
- Batcha liknande kontroller i heartbeat i stället för flera cron-jobb.
- Använd `target: "none"` på heartbeat om du bara vill ha intern bearbetning.
- Använd isolerad cron med en billigare modell för rutinuppgifter.

## Relaterat

- [Heartbeat](/gateway/heartbeat) – fullständig heartbeat-konfiguration
- [Cron jobs](/automation/cron-jobs) – fullständig CLI- och API-referens för cron
- [System](/cli/system) – systemhändelser + heartbeat-kontroller
