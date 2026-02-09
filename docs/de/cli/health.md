---
summary: "CLI-Referenz für `openclaw health` (Gateway-Gesundheitsendpunkt über RPC)"
read_when:
  - Sie möchten die Gesundheit des laufenden Gateways schnell prüfen
title: "Gesundheit"
---

# `openclaw health`

Ruft den Gesundheitsstatus vom laufenden Gateway ab.

```bash
openclaw health
openclaw health --json
openclaw health --verbose
```

Hinweise:

- `--verbose` führt Live-Probes aus und gibt bei mehreren konfigurierten Konten zeitliche Messwerte pro Konto aus.
- Die Ausgabe enthält Sitzungsspeicher pro Agent, wenn mehrere Agenten konfiguriert sind.
