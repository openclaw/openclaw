---
summary: "Vejledning til valg mellem heartbeat og cron-jobs til automatisering"
read_when:
  - Når du beslutter, hvordan tilbagevendende opgaver skal planlægges
  - Opsætning af baggrundsovervågning eller notifikationer
  - Optimering af tokenforbrug ved periodiske tjek
title: "Cron vs Heartbeat"
---

# Cron vs Heartbeat: Hvornår skal du bruge hvad

Både hjerteslag og cron job lader dig køre opgaver på en tidsplan. Denne guide hjælper dig med at vælge den rigtige mekanisme til din brug kasse.

## Hurtig beslutningsguide

| Use case                                         | Anbefalet                              | Hvorfor                                   |
| ------------------------------------------------ | -------------------------------------- | ----------------------------------------- |
| Afkryds indbakke hver 30 min.    | Heartbeat                              | Batch’er med andre tjek, kontekstbevidst  |
| Send daglig rapport kl. 9 præcis | Cron (isoleret)     | Kræver præcis timing                      |
| Overvåg kalender for kommende begivenheder       | Heartbeat                              | Naturligt match til periodisk overblik    |
| Kør ugentlig dybdegående analyse                 | Cron (isoleret)     | Selvstændig opgave, kan bruge anden model |
| Mind mig om 20 minutter                          | Cron (main, `--at`) | Éngangsopgave med præcis timing           |
| Baggrundstjek af projektsundhed                  | Heartbeat                              | Kører oven på eksisterende cyklus         |

## Heartbeat: Periodisk overblik

Hjertebanken kører i **hovedsessionen** med et regelmæssigt interval (standard: 30 min). De er designet til agenten til at kontrollere ting og overflade noget vigtigt.

### Hvornår skal du bruge heartbeat

- **Flere periodiske tjek**: I stedet for 5 separate cron-jobs, der tjekker indbakke, kalender, vejr, notifikationer og projektstatus, kan et enkelt heartbeat batch’e det hele.
- **Kontekstbevidste beslutninger**: Agenten har fuld kontekst fra hovedsessionen og kan derfor vurdere, hvad der er presserende vs. hvad der kan vente.
- **Samtalemæssig kontinuitet**: Heartbeat-kørsler deler samme session, så agenten husker nylige samtaler og kan følge naturligt op.
- **Overvågning med lav overhead**: Ét heartbeat erstatter mange små polling-opgaver.

### Fordele ved heartbeat

- **Batch’er flere tjek**: Ét agent-turn kan gennemgå indbakke, kalender og notifikationer samlet.
- **Reducerer API-kald**: Ét heartbeat er billigere end 5 isolerede cron-jobs.
- **Kontekstbevidst**: Agenten ved, hvad du har arbejdet på, og kan prioritere derefter.
- **Smart undertrykkelse**: Hvis intet kræver opmærksomhed, svarer agenten `HEARTBEAT_OK`, og der leveres ingen besked.
- **Naturlig timing**: Driver en smule afhængigt af købelastning, hvilket er fint for de fleste overvågningsopgaver.

### Heartbeat-eksempel: HEARTBEAT.md-tjekliste

```md
# Heartbeat checklist

- Check email for urgent messages
- Review calendar for events in next 2 hours
- If a background task finished, summarize results
- If idle for 8+ hours, send a brief check-in
```

Agenten læser dette ved hvert heartbeat og håndterer alle punkter i ét turn.

### Konfiguration af heartbeat

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

Se [Heartbeat](/gateway/heartbeat) for fuld konfiguration.

## Cron: Præcis planlægning

Cron-jobs kører på **eksakte tidspunkter** og kan køre i isolerede sessioner uden at påvirke hovedkonteksten.

### Hvornår skal du bruge cron

- **Præcis timing kræves**: "Send dette kl. 9:00 hver mandag" (ikke "omkring kl. 9").
- **Selvstændige opgaver**: Opgaver, der ikke kræver samtalekontekst.
- **Anden model/tænkning**: Tung analyse, der berettiger en mere kraftfuld model.
- **Éngangspåmindelser**: "Mind mig om 20 minutter" med `--at`.
- **Støjende/hyppige opgaver**: Opgaver, der ville rode i hovedsessionens historik.
- **Eksterne triggere**: Opgaver, der skal køre uafhængigt af, om agenten ellers er aktiv.

### Fordele ved cron

- **Præcis timing**: 5-felts cron-udtryk med tidszoneunderstøttelse.
- **Sessionsisolering**: Kører i `cron:<jobId>` uden at forurene hovedhistorikken.
- **Model-overrides**: Brug en billigere eller mere kraftfuld model pr. job.
- **Leveringskontrol**: Isolerede jobs bruger som standard `announce` (resume); vælg `none` efter behov.
- **Øjeblikkelig levering**: Announce-tilstand poster direkte uden at vente på heartbeat.
- **Ingen agentkontekst nødvendig**: Kører selv hvis hovedsessionen er inaktiv eller komprimeret.
- **Éngangsunderstøttelse**: `--at` for præcise fremtidige tidsstempler.

### Cron-eksempel: Daglig morgenbriefing

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

Dette kører præcis kl. 7:00 New York-tid, bruger Opus for kvalitet og annoncerer et resume direkte til WhatsApp.

### Cron-eksempel: Éngangspåmindelse

```bash
openclaw cron add \
  --name "Meeting reminder" \
  --at "20m" \
  --session main \
  --system-event "Reminder: standup meeting starts in 10 minutes." \
  --wake now \
  --delete-after-run
```

Se [Cron jobs](/automation/cron-jobs) for fuld CLI-reference.

## Beslutningsflowchart

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

## Kombination af begge

Den mest effektive opsætning bruger **begge**:

1. **Hjertebeat** håndterer rutinemæssig overvågning (indbakke, kalender, meddelelser) i én drejning hvert 30. minut.
2. **Cron** håndterer præcise tidsplaner (daglige rapporter, ugentlige reviews) og éngangspåmindelser.

### Eksempel: Effektiv automatiseringsopsætning

**HEARTBEAT.md** (kontrolleres hver 30 min):

```md
# Heartbeat checklist

- Scan inbox for urgent emails
- Check calendar for events in next 2h
- Review any pending tasks
- Light check-in if quiet for 8+ hours
```

**Cron-jobs** (præcis timing):

```bash
# Daily morning briefing at 7am
openclaw cron add --name "Morning brief" --cron "0 7 * * *" --session isolated --message "..." --announce

# Weekly project review on Mondays at 9am
openclaw cron add --name "Weekly review" --cron "0 9 * * 1" --session isolated --message "..." --model opus

# One-shot reminder
openclaw cron add --name "Call back" --at "2h" --session main --system-event "Call back the client" --wake now
```

## Lobster: Deterministiske workflows med godkendelser

Hummer er arbejdsgangstiden for **flertrinsværktøjsrørledninger**, der har brug for deterministisk udførelse og udtrykkelige godkendelser.
Brug den, når opgaven er mere end en enkelt agent tur, og du ønsker en genoptagelig arbejdsgang med menneskelige checkpoints.

### Hvornår Lobster passer

- **Flertrinsautomatisering**: Du har brug for en fast pipeline af værktøjskald, ikke en enkelt prompt.
- **Godkendelsesporte**: Sideeffekter skal pause, indtil du godkender, og derefter genoptage.
- **Genoptagelige kørsler**: Fortsæt et pauset workflow uden at genkøre tidligere trin.

### Sådan spiller den sammen med heartbeat og cron

- **Heartbeat/cron** beslutter _hvornår_ en kørsel sker.
- **Lobster** definerer _hvilke trin_ der sker, når kørslen starter.

For planlagte arbejdsgange, bruge cron eller hjerteslag til at udløse en agent drej der kalder Lobster.
For ad hoc-arbejdsgange, kald Hummer direkte.

### Driftsnoter (fra koden)

- Lobster kører som en **lokal subprocess** (`lobster` CLI) i tool-tilstand og returnerer en **JSON-konvolut**.
- Hvis værktøjet returnerer `needs_approval`, genoptager du med en `resumeToken` og `approve` flag.
- Værktøjet er et **valgfrit plugin**; aktivér det additivt via `tools.alsoAllow: ["lobster"]` (anbefalet).
- Hvis du sender `lobsterPath`, skal det være en **absolut sti**.

Se [Lobster](/tools/lobster) for fuld brug og eksempler.

## Hovedsession vs. Isoleret session

Både heartbeat og cron kan interagere med hovedsessionen, men på forskellige måder:

|          | Heartbeat                        | Cron (main)               | Cron (isoleret)            |
| -------- | -------------------------------- | -------------------------------------------- | --------------------------------------------- |
| Session  | Main                             | Main (via systemhændelse) | `cron:<jobId>`                                |
| Historik | Delt                             | Delt                                         | Ny ved hver kørsel                            |
| Kontekst | Fuld                             | Fuld                                         | Ingen (starter rent)       |
| Model    | Hovedsessionens model            | Hovedsessionens model                        | Kan overrides                                 |
| Output   | Leveres hvis ikke `HEARTBEAT_OK` | Heartbeat-prompt + hændelse                  | Annoncer resume (standard) |

### Hvornår skal du bruge main session cron

Brug `--session main` med `--system-event`, når du vil have:

- At påmindelsen/hændelsen vises i hovedsessionens kontekst
- At agenten håndterer den ved næste heartbeat med fuld kontekst
- Ingen separat isoleret kørsel

```bash
openclaw cron add \
  --name "Check project" \
  --every "4h" \
  --session main \
  --system-event "Time for a project health check" \
  --wake now
```

### Hvornår skal du bruge isoleret cron

Brug `--session isolated`, når du vil have:

- Et rent udgangspunkt uden forudgående kontekst
- Andre model- eller tænkeindstillinger
- Annoncering af resuméer direkte til en kanal
- Historik, der ikke roder i hovedsessionen

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

## Omkostningsovervejelser

| Mekanisme                          | Omkostningsprofil                                                                |
| ---------------------------------- | -------------------------------------------------------------------------------- |
| Heartbeat                          | Ét turn hver N minutter; skalerer med HEARTBEAT.md-størrelse     |
| Cron (main)     | Tilføjer hændelse til næste heartbeat (ingen isoleret kørsel) |
| Cron (isoleret) | Fuldt agent-turn pr. job; kan bruge billigere model              |

**Tips**:

- Hold `HEARTBEAT.md` lille for at minimere token-overhead.
- Batch lignende tjek i heartbeat i stedet for flere cron-jobs.
- Brug `target: "none"` på heartbeat, hvis du kun vil have intern behandling.
- Brug isoleret cron med en billigere model til rutineopgaver.

## Relateret

- [Heartbeat](/gateway/heartbeat) – fuld heartbeat-konfiguration
- [Cron jobs](/automation/cron-jobs) – fuld cron CLI- og API-reference
- [System](/cli/system) – systemhændelser + heartbeat-kontroller
