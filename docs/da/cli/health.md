---
summary: "CLI-reference for `openclaw health` (Gateway-helbredsendepunkt via RPC)"
read_when:
  - Du vil hurtigt tjekke den kørende Gateways helbred
title: "health"
---

# `openclaw health`

Hent helbredsstatus fra den kørende Gateway.

```bash
openclaw health
openclaw health --json
openclaw health --verbose
```

Noter:

- `--verbose` kører live-prober og udskriver tidsmålinger pr. konto, når flere konti er konfigureret.
- Output inkluderer sessionslagre pr. agent, når flere agenter er konfigureret.
