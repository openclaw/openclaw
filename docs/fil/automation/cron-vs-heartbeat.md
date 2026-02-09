---
summary: "Gabay sa pagpili sa pagitan ng heartbeat at mga cron job para sa automation"
read_when:
  - Nagpapasya kung paano mag-iskedyul ng mga paulit-ulit na gawain
  - Nagse-setup ng background monitoring o mga notification
  - Pag-o-optimize ng paggamit ng token para sa mga pana-panahong check
title: "Cron vs Heartbeat"
---

# Cron vs Heartbeat: Kailan Gagamitin ang Bawat Isa

Both heartbeats and cron jobs let you run tasks on a schedule. This guide helps you choose the right mechanism for your use case.

## Mabilis na Gabay sa Pagpapasya

| Use Case                                           | Inirerekomenda                         | Bakit                                                 |
| -------------------------------------------------- | -------------------------------------- | ----------------------------------------------------- |
| I-check ang inbox bawat 30 min                     | Heartbeat                              | Na-ba-batch kasama ng ibang check, context-aware      |
| Magpadala ng arawang ulat eksaktong 9am            | Cron (isolated)     | Kailangan ng eksaktong oras                           |
| I-monitor ang calendar para sa paparating na event | Heartbeat                              | Natural na akma para sa pana-panahong awareness       |
| Magpatakbo ng lingguhang malalim na analysis       | Cron (isolated)     | Standalone na gawain, puwedeng gumamit ng ibang model |
| Paalalahanan ako sa loob ng 20 minuto              | Cron (main, `--at`) | One-shot na may eksaktong timing                      |
| Background na health check ng proyekto             | Heartbeat                              | Sumasabay sa umiiral na cycle                         |

## Heartbeat: Pana-panahong Awareness

Heartbeats run in the **main session** at a regular interval (default: 30 min). They're designed for the agent to check on things and surface anything important.

### Kailan gagamit ng heartbeat

- **Maramihang pana-panahong check**: Sa halip na 5 magkakahiwalay na cron job na nagche-check ng inbox, calendar, weather, notifications, at status ng proyekto, isang heartbeat lang ang puwedeng mag-batch ng lahat ng ito.
- **Context-aware na mga desisyon**: May buong main-session context ang agent, kaya nakakagawa ito ng matatalinong desisyon kung alin ang urgent at alin ang puwedeng maghintay.
- **Pagpapatuloy ng usapan**: Iisang session ang gamit ng mga heartbeat run, kaya naaalala ng agent ang mga kamakailang usapan at natural na nakakapag-follow up.
- **Low-overhead na monitoring**: Isang heartbeat ang pumapalit sa maraming maliliit na polling task.

### Mga bentahe ng heartbeat

- **Nagba-batch ng maraming check**: Isang agent turn ang puwedeng mag-review ng inbox, calendar, at notifications nang sabay.
- **Binabawasan ang API calls**: Mas mura ang isang heartbeat kaysa sa 5 isolated na cron job.
- **Context-aware**: Alam ng agent kung ano ang iyong ginagawa at kayang mag-prioritize ayon dito.
- **Smart suppression**: Kung walang kailangang pansinin, sasagot ang agent ng `HEARTBEAT_OK` at walang mensaheng ipapadala.
- **Natural na timing**: Bahagyang nagdi-drift depende sa queue load, na ayos lang para sa karamihan ng monitoring.

### Halimbawa ng heartbeat: HEARTBEAT.md checklist

```md
# Heartbeat checklist

- Check email for urgent messages
- Review calendar for events in next 2 hours
- If a background task finished, summarize results
- If idle for 8+ hours, send a brief check-in
```

Binabasa ito ng agent sa bawat heartbeat at hinahawakan ang lahat ng item sa iisang turn.

### Pagko-configure ng heartbeat

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

Tingnan ang [Heartbeat](/gateway/heartbeat) para sa kumpletong configuration.

## Cron: Eksaktong Pag-iskedyul

Tumatakbo ang mga cron job sa **eksaktong oras** at puwedeng tumakbo sa mga isolated session nang hindi naaapektuhan ang main context.

### Kailan gagamit ng cron

- **Kailangan ng eksaktong oras**: “Ipadala ito tuwing 9:00 AM bawat Lunes” (hindi “bandang 9”).
- **Standalone na mga gawain**: Mga task na hindi nangangailangan ng conversational context.
- **Ibang model/pag-iisip**: Mabibigat na analysis na nangangailangan ng mas malakas na model.
- **One-shot na mga paalala**: “Paalalahanan ako sa loob ng 20 minuto” gamit ang `--at`.
- **Maingay/madalas na gawain**: Mga task na makakalat sa history ng main session.
- **External triggers**: Mga task na dapat tumakbo nang hiwalay kahit hindi aktibo ang agent.

### Mga bentahe ng cron

- **Eksaktong oras**: 5-field na cron expressions na may timezone support.
- **Session isolation**: Tumatakbo sa `cron:<jobId>` nang hindi dinudumihan ang main history.
- **Model overrides**: Gumamit ng mas mura o mas malakas na model kada job.
- **Kontrol sa delivery**: Ang isolated jobs ay default sa `announce` (summary); piliin ang `none` kung kailangan.
- **Agarang delivery**: Direktang nagpo-post ang announce mode nang hindi naghihintay ng heartbeat.
- **Hindi kailangan ang agent context**: Tumatakbo kahit idle o na-compact ang main session.
- **Suporta sa one-shot**: `--at` para sa eksaktong future timestamps.

### Halimbawa ng cron: Araw-araw na morning briefing

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

Tumatakbo ito eksaktong 7:00 AM oras ng New York, gumagamit ng Opus para sa kalidad, at direktang nag-a-announce ng summary sa WhatsApp.

### Halimbawa ng cron: One-shot na paalala

```bash
openclaw cron add \
  --name "Meeting reminder" \
  --at "20m" \
  --session main \
  --system-event "Reminder: standup meeting starts in 10 minutes." \
  --wake now \
  --delete-after-run
```

Tingnan ang [Cron jobs](/automation/cron-jobs) para sa kumpletong CLI reference.

## Decision Flowchart

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

## Pagsasama ng Pareho

Ang pinaka-episyenteng setup ay gumagamit ng **pareho**:

1. **Heartbeat** ang humahawak ng routine monitoring (inbox, calendar, notifications) sa iisang batched turn bawat 30 minuto.
2. **Cron** ang humahawak ng eksaktong iskedyul (arawang ulat, lingguhang review) at mga one-shot na paalala.

### Halimbawa: Episyenteng automation setup

**HEARTBEAT.md** (chine-check bawat 30 min):

```md
# Heartbeat checklist

- Scan inbox for urgent emails
- Check calendar for events in next 2h
- Review any pending tasks
- Light check-in if quiet for 8+ hours
```

**Mga cron job** (eksaktong timing):

```bash
# Daily morning briefing at 7am
openclaw cron add --name "Morning brief" --cron "0 7 * * *" --session isolated --message "..." --announce

# Weekly project review on Mondays at 9am
openclaw cron add --name "Weekly review" --cron "0 9 * * 1" --session isolated --message "..." --model opus

# One-shot reminder
openclaw cron add --name "Call back" --at "2h" --session main --system-event "Call back the client" --wake now
```

## Lobster: Deterministic na mga workflow na may approvals

Lobster is the workflow runtime for **multi-step tool pipelines** that need deterministic execution and explicit approvals.
Use it when the task is more than a single agent turn, and you want a resumable workflow with human checkpoints.

### Kailan akma ang Lobster

- **Multi-step na automation**: Kailangan mo ng fixed pipeline ng mga tool call, hindi one-off na prompt.
- **Approval gates**: Ang mga side effect ay dapat mag-pause hanggang mag-approve ka, saka mag-resume.
- **Resumable runs**: Ipagpatuloy ang naka-pause na workflow nang hindi inuulit ang mga naunang hakbang.

### Paano ito ipinares sa heartbeat at cron

- **Heartbeat/cron** ang nagdedesisyon kung _kailan_ tatakbo ang isang run.
- **Lobster** ang nagde-define kung _anong mga hakbang_ ang mangyayari kapag nagsimula na ang run.

For scheduled workflows, use cron or heartbeat to trigger an agent turn that calls Lobster.
For ad-hoc workflows, call Lobster directly.

### Mga tala sa operasyon (mula sa code)

- Tumatakbo ang Lobster bilang **local subprocess** (`lobster` CLI) sa tool mode at nagbabalik ng **JSON envelope**.
- Kung magbalik ang tool ng `needs_approval`, magre-resume ka gamit ang `resumeToken` at ang `approve` flag.
- Ang tool ay isang **opsyonal na plugin**; i-enable ito nang additively sa pamamagitan ng `tools.alsoAllow: ["lobster"]` (inirerekomenda).
- Kung ipapasa mo ang `lobsterPath`, dapat itong isang **absolute path**.

Tingnan ang [Lobster](/tools/lobster) para sa kumpletong paggamit at mga halimbawa.

## Main Session vs Isolated Session

Parehong puwedeng makipag-interact ang heartbeat at cron sa main session, pero magkaiba ang paraan:

|         | Heartbeat                             | Cron (main)                           | Cron (isolated)                 |
| ------- | ------------------------------------- | -------------------------------------------------------- | -------------------------------------------------- |
| Session | Main                                  | Main (sa pamamagitan ng system event) | `cron:<jobId>`                                     |
| History | Shared                                | Shared                                                   | Bago sa bawat run                                  |
| Context | Buo                                   | Buo                                                      | Wala (nagsisimula nang malinis) |
| Model   | Model ng main session                 | Model ng main session                                    | Puwedeng i-override                                |
| Output  | Ipinapadala kung hindi `HEARTBEAT_OK` | Heartbeat prompt + event                                 | Announce summary (default)      |

### Kailan gagamit ng main session cron

Gamitin ang `--session main` kasama ang `--system-event` kapag gusto mo ng:

- Ang paalala/event ay lumabas sa main session context
- Hawakan ito ng agent sa susunod na heartbeat na may buong context
- Walang hiwalay na isolated run

```bash
openclaw cron add \
  --name "Check project" \
  --every "4h" \
  --session main \
  --system-event "Time for a project health check" \
  --wake now
```

### Kailan gagamit ng isolated cron

Gamitin ang `--session isolated` kapag gusto mo ng:

- Malinis na simula na walang dating context
- Ibang model o thinking settings
- Direktang pag-announce ng mga summary sa isang channel
- History na hindi nakakalat sa main session

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

## Mga Pagsasaalang-alang sa Gastos

| Mekanismo                          | Profile ng Gastos                                                                      |
| ---------------------------------- | -------------------------------------------------------------------------------------- |
| Heartbeat                          | Isang turn bawat N minuto; nag-i-scale ayon sa laki ng HEARTBEAT.md    |
| Cron (main)     | Nagdaragdag ng event sa susunod na heartbeat (walang isolated turn) |
| Cron (isolated) | Buong agent turn bawat job; puwedeng gumamit ng mas murang model                       |

**Mga Tip**:

- Panatilihing maliit ang `HEARTBEAT.md` para mabawasan ang token overhead.
- I-batch ang magkakatulad na check sa heartbeat sa halip na maraming cron job.
- Gamitin ang `target: "none"` sa heartbeat kung internal processing lang ang gusto mo.
- Gumamit ng isolated cron na may mas murang model para sa mga routine na gawain.

## Kaugnay

- [Heartbeat](/gateway/heartbeat) - kumpletong configuration ng heartbeat
- [Cron jobs](/automation/cron-jobs) - kumpletong cron CLI at API reference
- [System](/cli/system) - mga system event + kontrol sa heartbeat
