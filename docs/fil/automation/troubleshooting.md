---
summary: "I-troubleshoot ang pag-iiskedyul at paghahatid ng cron at heartbeat"
read_when:
  - Hindi tumakbo ang cron
  - Tumakbo ang cron pero walang naihatid na mensahe
  - Mukhang tahimik o nilaktawan ang heartbeat
title: "Pag-troubleshoot ng Automation"
---

# Pag-troubleshoot ng automation

Gamitin ang pahinang ito para sa mga isyu sa scheduler at delivery (`cron` + `heartbeat`).

## Command ladder

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

Pagkatapos ay patakbuhin ang mga automation check:

```bash
openclaw cron status
openclaw cron list
openclaw system heartbeat last
```

## Hindi nagpapaputok ang cron

```bash
openclaw cron status
openclaw cron list
openclaw cron runs --id <jobId> --limit 20
openclaw logs --follow
```

Ganito ang hitsura ng magandang output:

- Ang `cron status` ay nag-uulat na enabled at may hinaharap na `nextWakeAtMs`.
- Enabled ang job at may wastong iskedyul/timezone.
- Ipinapakita ng `cron runs` ang `ok` o isang hayagang dahilan ng pag-skip.

Mga karaniwang signature:

- `cron: scheduler disabled; jobs will not run automatically` → naka-disable ang cron sa config/env.
- `cron: timer tick failed` → nag-crash ang scheduler tick; siyasatin ang kalapit na stack/log context.
- `reason: not-due` sa run output → tinawag ang manual run nang walang `--force` at hindi pa due ang job.

## Nagpaputok ang cron pero walang delivery

```bash
openclaw cron runs --id <jobId> --limit 20
openclaw cron list
openclaw channels status --probe
openclaw logs --follow
```

Ganito ang hitsura ng magandang output:

- Ang status ng run ay `ok`.
- Nakakabit ang delivery mode/target para sa mga isolated job.
- Ang channel probe ay nag-uulat na konektado ang target channel.

Mga karaniwang signature:

- Matagumpay ang run pero ang delivery mode ay `none` → walang inaasahang external na mensahe.
- Nawawala o invalid ang delivery target (`channel`/`to`) → maaaring magtagumpay ang run sa loob ngunit laktawan ang outbound.
- Mga error sa auth ng channel (`unauthorized`, `missing_scope`, `Forbidden`) → naharang ang delivery dahil sa credentials/permissions ng channel.

## Pinigil o nilaktawan ang heartbeat

```bash
openclaw system heartbeat last
openclaw logs --follow
openclaw config get agents.defaults.heartbeat
openclaw channels status --probe
```

Ganito ang hitsura ng magandang output:

- Enabled ang heartbeat na may hindi zero na interval.
- Ang huling resulta ng heartbeat ay `ran` (o nauunawaan ang dahilan ng pag-skip).

Mga karaniwang signature:

- `heartbeat skipped` na may `reason=quiet-hours` → nasa labas ng `activeHours`.
- `requests-in-flight` → abala ang main lane; ipinagpaliban ang heartbeat.
- `empty-heartbeat-file` → may umiiral na `HEARTBEAT.md` pero walang actionable na nilalaman.
- `alerts-disabled` → pinipigilan ng mga setting ng visibility ang outbound na mga mensahe ng heartbeat.

## Mga gotcha sa timezone at activeHours

```bash
openclaw config get agents.defaults.heartbeat.activeHours
openclaw config get agents.defaults.heartbeat.activeHours.timezone
openclaw config get agents.defaults.userTimezone || echo "agents.defaults.userTimezone not set"
openclaw cron list
openclaw logs --follow
```

Mga mabilis na tuntunin:

- Ang `Config path not found: agents.defaults.userTimezone` ay nangangahulugang unset ang key; babagsak ang heartbeat sa timezone ng host (o `activeHours.timezone` kung naka-set).
- Ang cron na walang `--tz` ay gumagamit ng timezone ng host ng gateway.
- Ang heartbeat na `activeHours` ay gumagamit ng naka-configure na resolusyon ng timezone (`user`, `local`, o hayagang IANA tz).
- Ang mga ISO timestamp na walang timezone ay itinuturing na UTC para sa mga iskedyul ng cron na `at`.

Mga karaniwang signature:

- Tumatakbo ang mga job sa maling wall-clock time pagkatapos magbago ang timezone ng host.
- Palaging nilalaktawan ang heartbeat sa oras ng araw ninyo dahil mali ang `activeHours.timezone`.

Kaugnay:

- [/automation/cron-jobs](/automation/cron-jobs)
- [/gateway/heartbeat](/gateway/heartbeat)
- [/automation/cron-vs-heartbeat](/automation/cron-vs-heartbeat)
- [/concepts/timezone](/concepts/timezone)
