---
summary: "CLI-referens för `openclaw health` (Gateway-hälsoendpoint via RPC)"
read_when:
  - Du vill snabbt kontrollera den körande Gatewayns hälsa
title: "hälsa"
---

# `openclaw health`

Hämta hälsostatus från den körande Gateway.

```bash
openclaw health
openclaw health --json
openclaw health --verbose
```

Noteringar:

- `--verbose` kör live-prober och skriver ut tidsmätningar per konto när flera konton är konfigurerade.
- Utdata inkluderar sessionslager per agent när flera agenter är konfigurerade.
