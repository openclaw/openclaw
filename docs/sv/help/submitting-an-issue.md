---
summary: "Att rapportera ärenden och felrapporter med högt signalvärde"
title: "Skicka in ett ärende"
x-i18n:
  source_path: help/submitting-an-issue.md
  source_hash: bcb33f05647e9f0d
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:17:28Z
---

## Skicka in ett ärende

Tydliga, koncisa ärenden påskyndar diagnos och åtgärder. Inkludera följande för buggar, regressioner eller funktionsluckor:

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

Var kortfattad. Koncishet > perfekt grammatik.

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

_Undvik hemligheter/exploateringsdetaljer offentligt. För känsliga ärenden, minimera detaljer och begär privat rapportering._

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

Ärende före PR är valfritt. Inkludera detaljer i PR om du hoppar över det. Håll PR:en fokuserad, ange ärendenummer, lägg till tester eller förklara varför de saknas, dokumentera beteendeförändringar/risker, inkludera avidentifierade loggar/skärmbilder som bevis och kör korrekt validering innan inlämning.
