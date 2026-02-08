---
summary: "Sanggunian ng CLI para sa `openclaw system` (mga system event, heartbeat, presence)"
read_when:
  - Gusto mong mag-enqueue ng system event nang hindi gumagawa ng cron job
  - Kailangan mong i-enable o i-disable ang mga heartbeat
  - Gusto mong inspeksyunin ang mga entry ng system presence
title: "sistema"
x-i18n:
  source_path: cli/system.md
  source_hash: 36ae5dbdec327f5a
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:45:21Z
---

# `openclaw system`

Mga helper sa antas ng system para sa Gateway: mag-enqueue ng mga system event, kontrolin ang mga heartbeat,
at tingnan ang presence.

## Common commands

```bash
openclaw system event --text "Check for urgent follow-ups" --mode now
openclaw system heartbeat enable
openclaw system heartbeat last
openclaw system presence
```

## `system event`

Mag-enqueue ng system event sa **main** session. Ang susunod na heartbeat ay mag-i-inject
nito bilang isang `System:` na linya sa prompt. Gamitin ang `--mode now` para i-trigger ang heartbeat
kaagad; ang `next-heartbeat` ay maghihintay sa susunod na naka-iskedyul na tick.

Flags:

- `--text <text>`: kinakailangang text ng system event.
- `--mode <mode>`: `now` o `next-heartbeat` (default).
- `--json`: machine-readable na output.

## `system heartbeat last|enable|disable`

Mga kontrol ng heartbeat:

- `last`: ipakita ang huling heartbeat event.
- `enable`: ibalik ang mga heartbeat (gamitin ito kung na-disable ang mga ito).
- `disable`: i-pause ang mga heartbeat.

Flags:

- `--json`: machine-readable na output.

## `system presence`

Ilista ang kasalukuyang mga entry ng system presence na alam ng Gateway (mga node,
mga instance, at mga katulad na status line).

Flags:

- `--json`: machine-readable na output.

## Mga tala

- Nangangailangan ng tumatakbong Gateway na maaabot ng iyong kasalukuyang config (local o remote).
- Ang mga system event ay pansamantala at hindi pinapanatili sa pagitan ng mga restart.
