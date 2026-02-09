---
summary: "Att rapportera ärenden och felrapporter med högt signalvärde"
title: "Skicka in ett ärende"
---

## Skicka in ett ärende

Tydliga och koncisa problem påskyndar diagnos och korrigeringar. Inkludera följande för buggar, regressioner eller luckor i funktionen:

### Vad som ska ingå

- [ ] Titel: område och symptom
- [ ] Minimala reprosteg
- [ ] Förväntat vs faktiskt
- [ ] Påverkan och allvarlighetsgrad
- [ ] Miljö: OS, runtime, versioner, konfig
- [ ] Bevis: avidentifierade loggar, skärmbilder (ingen PII)
- [ ] Omfattning: nytt, regression eller långvarigt
- [ ] Kodord: lobster-biscuit i ditt ärende
- [ ] Sökt i kodbasen och på GitHub efter befintligt ärende
- [ ] Bekräftat att det inte nyligen är åtgärdat/adresserat (särskilt säkerhet)
- [ ] Påståenden styrkta med bevis eller repro

Var kortfattad. Terseness > perfekt grammatik.

Validering (kör/åtgärda före PR):

- `pnpm lint`
- `pnpm check`
- `pnpm build`
- `pnpm test`
- Om protokollkod: `pnpm protocol:check`

### Mallar

#### Buggrapport

```md
- [ ] Minimal repro
- [ ] Expected vs actual
- [ ] Environment
- [ ] Affected channels, where not seen
- [ ] Logs/screenshots (redacted)
- [ ] Impact/severity
- [ ] Workarounds

### Summary

### Repro Steps

### Expected

### Actual

### Environment

### Logs/Evidence

### Impact

### Workarounds
```

#### Säkerhetsärende

```md
### Summary

### Impact

### Versions

### Repro Steps (safe to share)

### Mitigation/workaround

### Evidence (redacted)
```

_Undvik hemligheter/utnyttja detaljer offentligt. För känsliga frågor, minimera detaljer och begära privat avslöjande._

#### Regressionsrapport

```md
### Summary

### Last Known Good

### First Known Bad

### Repro Steps

### Expected

### Actual

### Environment

### Logs/Evidence

### Impact
```

#### Funktionsförfrågan

```md
### Summary

### Problem

### Proposed Solution

### Alternatives

### Impact

### Evidence/examples
```

#### Förbättring

```md
### Summary

### Current vs Desired Behavior

### Rationale

### Alternatives

### Evidence/examples
```

#### Utredning

```md
### Summary

### Symptoms

### What Was Tried

### Environment

### Logs/Evidence

### Impact
```

### Skicka in en fix-PR

Problem innan PR är valfritt. Inkludera information i PR vid hoppning. Håll PR fokuserad, anteckningsproblemsnummer, lägg till tester eller förklara frånvaro, ändringar i dokumentbeteende/risker, inkludera rättade loggar/skärmdumpar som bevis, och kör korrekt validering innan du skickar in.
