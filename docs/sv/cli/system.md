---
summary: "CLI-referens för `openclaw system` (systemhändelser, heartbeat, presence)"
read_when:
  - Du vill köa en systemhändelse utan att skapa ett cron-jobb
  - Du behöver aktivera eller inaktivera heartbeats
  - Du vill granska systemets presence-poster
title: "system"
---

# `openclaw system`

Systemhjälpare på systemnivå för Gateway (nätverksgateway): köa systemhändelser, styra heartbeats
och visa presence.

## Vanliga kommandon

```bash
openclaw system event --text "Check for urgent follow-ups" --mode now
openclaw system heartbeat enable
openclaw system heartbeat last
openclaw system presence
```

## `system event`

Kö en systemhändelse på **main**-sessionen. Nästa hjärtslag kommer att injicera
det som en `System:` linje i prompten. Använd `--mode nu` för att utlösa hjärtslag
omedelbart; `nästa-heartbeat` väntar på nästa schemalagda tick.

Flaggor:

- `--text <text>`: obligatorisk text för systemhändelsen.
- `--mode <mode>`: `now` eller `next-heartbeat` (standard).
- `--json`: maskinläsbar utdata.

## `system heartbeat last|enable|disable`

Styrning av heartbeats:

- `last`: visa den senaste heartbeat-händelsen.
- `enable`: slå på heartbeats igen (använd detta om de var inaktiverade).
- `disable`: pausa heartbeats.

Flaggor:

- `--json`: maskinläsbar utdata.

## `system presence`

Lista de aktuella systemets presence-poster som Gateway (nätverksgateway) känner till (noder,
instanser och liknande statusrader).

Flaggor:

- `--json`: maskinläsbar utdata.

## Noteringar

- Kräver en körande Gateway (nätverksgateway) som är nåbar via din nuvarande konfig (lokal eller fjärr).
- Systemhändelser är flyktiga och sparas inte över omstarter.
