---
summary: "CLI-reference for `openclaw system` (systemhændelser, heartbeat, tilstedeværelse)"
read_when:
  - Du vil sætte en systemhændelse i kø uden at oprette et cron-job
  - Du skal aktivere eller deaktivere heartbeats
  - Du vil inspicere systemets tilstedeværelsesposter
title: "system"
x-i18n:
  source_path: cli/system.md
  source_hash: 36ae5dbdec327f5a
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:04Z
---

# `openclaw system`

Hjælpefunktioner på systemniveau til Gateway: sæt systemhændelser i kø, styr heartbeats
og vis tilstedeværelse.

## Common commands

```bash
openclaw system event --text "Check for urgent follow-ups" --mode now
openclaw system heartbeat enable
openclaw system heartbeat last
openclaw system presence
```

## `system event`

Sæt en systemhændelse i kø på **main**-sessionen. Den næste heartbeat vil injicere
den som en `System:`-linje i prompten. Brug `--mode now` til at udløse heartbeat
med det samme; `next-heartbeat` venter på den næste planlagte tick.

Flag:

- `--text <text>`: påkrævet tekst for systemhændelsen.
- `--mode <mode>`: `now` eller `next-heartbeat` (standard).
- `--json`: maskinlæsbar output.

## `system heartbeat last|enable|disable`

Kontrol af heartbeats:

- `last`: vis den seneste heartbeat-hændelse.
- `enable`: slå heartbeats til igen (brug dette, hvis de var deaktiveret).
- `disable`: sæt heartbeats på pause.

Flag:

- `--json`: maskinlæsbar output.

## `system presence`

Vis de aktuelle system-tilstedeværelsesposter, som Gateway kender til (noder,
instanser og lignende statuslinjer).

Flag:

- `--json`: maskinlæsbar output.

## Noter

- Kræver en kørende Gateway, som kan nås via din nuværende konfiguration (lokal eller fjern).
- Systemhændelser er flygtige og gemmes ikke på tværs af genstarter.
