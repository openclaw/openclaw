---
summary: "Referencja CLI dla `openclaw voicecall` (powierzchnia poleceń wtyczki voice-call)"
read_when:
  - Używasz wtyczki voice-call i potrzebujesz punktów wejścia CLI
  - Chcesz szybkich przykładów dla `voicecall call|continue|status|tail|expose`
title: "voicecall"
---

# `openclaw voicecall`

`voicecall` jest poleceniem dostarczanym przez wtyczkę. Pojawia się tylko wtedy, gdy wtyczka voice-call jest zainstalowana i włączona.

Dokument główny:

- Wtyczka voice-call: [Voice Call](/plugins/voice-call)

## Typowe polecenia

```bash
openclaw voicecall status --call-id <id>
openclaw voicecall call --to "+15555550123" --message "Hello" --mode notify
openclaw voicecall continue --call-id <id> --message "Any questions?"
openclaw voicecall end --call-id <id>
```

## Wystawianie webhooków (Tailscale)

```bash
openclaw voicecall expose --mode serve
openclaw voicecall expose --mode funnel
openclaw voicecall unexpose
```

Uwaga dotycząca bezpieczeństwa: wystawiaj punkt końcowy webhooka wyłącznie do sieci, którym ufasz. Gdy to możliwe, preferuj Tailscale Serve zamiast Funnel.
