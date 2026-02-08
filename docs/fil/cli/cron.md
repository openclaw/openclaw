---
summary: "Reference ng CLI para sa `openclaw cron` (mag-iskedyul at magpatakbo ng mga background job)"
read_when:
  - Gusto mo ng mga naka-iskedyul na job at wakeup
  - Nagde-debug ka ng pagtakbo ng cron at mga log
title: "cron"
x-i18n:
  source_path: cli/cron.md
  source_hash: 09982d6dd1036a56
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:45:23Z
---

# `openclaw cron`

Pamahalaan ang mga cron job para sa scheduler ng Gateway.

Kaugnay:

- Mga cron job: [Mga cron job](/automation/cron-jobs)

Tip: patakbuhin ang `openclaw cron --help` para sa buong saklaw ng mga command.

Note: ang mga isolated na `cron add` job ay naka-default sa `--announce` delivery. Gamitin ang `--no-deliver` para panatilihing internal ang
output. Ang `--deliver` ay nananatiling isang deprecated na alias para sa `--announce`.

Note: ang mga one-shot (`--at`) job ay awtomatikong dine-delete pagkatapos ng tagumpay bilang default. Gamitin ang `--keep-after-run` para panatilihin ang mga ito.

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
