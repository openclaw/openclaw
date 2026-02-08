---
summary: "Indsendelse af issues og fejlrapporter med højt signal"
title: "Indsendelse af en issue"
x-i18n:
  source_path: help/submitting-an-issue.md
  source_hash: bcb33f05647e9f0d
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:19Z
---

## Indsendelse af en issue

Klare og præcise issues fremskynder diagnosticering og rettelser. Medtag følgende for bugs, regressioner eller manglende funktioner:

### Hvad du skal inkludere

- [ ] Titel: område & symptom
- [ ] Minimale repro-trin
- [ ] Forventet vs. faktisk
- [ ] Påvirkning & alvorlighed
- [ ] Miljø: OS, runtime, versioner, konfiguration
- [ ] Evidens: redigerede logs, skærmbilleder (uden PII)
- [ ] Omfang: ny, regression eller langvarig
- [ ] Kodeord: lobster-biscuit i din issue
- [ ] Har søgt i kodebasen & på GitHub efter eksisterende issue
- [ ] Bekræftet ikke for nylig rettet/adresseret (især sikkerhed)
- [ ] Påstande understøttet af evidens eller repro

Vær kortfattet. Knapphed > perfekt grammatik.

Validering (kør/ret før PR):

- `pnpm lint`
- `pnpm check`
- `pnpm build`
- `pnpm test`
- Hvis protokolkode: `pnpm protocol:check`

### Skabeloner

#### Bugrapport

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

#### Sikkerhedsissue

```md
### Summary

### Impact

### Versions

### Repro Steps (safe to share)

### Mitigation/workaround

### Evidence (redacted)
```

_Undgå hemmeligheder/udnyttelsesdetaljer offentligt. For følsomme issues, minimer detaljer og anmod om privat indberetning._

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

#### Funktionsønske

```md
### Summary

### Problem

### Proposed Solution

### Alternatives

### Impact

### Evidence/examples
```

#### Forbedring

```md
### Summary

### Current vs Desired Behavior

### Rationale

### Alternatives

### Evidence/examples
```

#### Undersøgelse

```md
### Summary

### Symptoms

### What Was Tried

### Environment

### Logs/Evidence

### Impact
```

### Indsendelse af en rettelses-PR

Issue før PR er valgfrit. Medtag detaljer i PR’en, hvis du springer over. Hold PR’en fokuseret, angiv issue-nummer, tilføj tests eller forklar fravær, dokumentér adfærdsændringer/risici, inkluder redigerede logs/skærmbilleder som dokumentation, og kør korrekt validering før indsendelse.
