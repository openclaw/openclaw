---
summary: "Reference ng CLI para sa `openclaw cron` (mag-iskedyul at magpatakbo ng mga background job)"
read_when:
  - Gusto mo ng mga naka-iskedyul na job at wakeup
  - Nagde-debug ka ng pagtakbo ng cron at mga log
title: "cron"
---

# `openclaw cron`

Pamahalaan ang mga cron job para sa scheduler ng Gateway.

Kaugnay:

- Mga cron job: [Mga cron job](/automation/cron-jobs)

Tip: patakbuhin ang `openclaw cron --help` para sa buong saklaw ng mga command.

50. Tandaan: ang mga isolated na `cron add` job ay default na may `--announce` delivery. 1. Gamitin ang `--no-deliver` upang panatilihing panloob ang output. 2. Ang `--deliver` ay nananatiling isang deprecated na alias para sa `--announce`.

3. Paalala: ang mga one-shot (`--at`) na job ay awtomatikong nabubura pagkatapos ng matagumpay na pagtakbo. 4. Gamitin ang `--keep-after-run` upang panatilihin ang mga ito.

Note: ang mga recurring job ay gumagamit na ngayon ng exponential retry backoff matapos ang sunod-sunod na error (30s → 1m → 5m → 15m → 60m), at pagkatapos ay babalik sa normal na iskedyul matapos ang susunod na matagumpay na run.

## Mga karaniwang pag-edit

I-update ang mga setting ng delivery nang hindi binabago ang mensahe:

```bash
openclaw cron edit <job-id> --announce --channel telegram --to "123456789"
```

I-disable ang delivery para sa isang isolated na job:

```bash
openclaw cron edit <job-id> --no-deliver
```

Mag-anunsyo sa isang partikular na channel:

```bash
openclaw cron edit <job-id> --announce --channel slack --to "channel:C1234567890"
```
