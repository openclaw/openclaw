---
summary: "Indsendelse af issues og fejlrapporter med højt signal"
title: "Indsendelse af en issue"
---

## Indsendelse af en issue

Klart, kortfattet spørgsmål fremskynde diagnose og rettelser. Inkludér følgende for fejl, regressioner eller funktionshuller:

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

Vær kortfattet. Terseness > perfekt grammatik.

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

_Undgå hemmeligheder/udnytte detaljer i offentligheden. For følsomme spørgsmål, minimere detaljer og anmode om privat offentliggørelse. _

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

Issue before PR is optional. (Automatic Copy) Inkludér detaljer i PR hvis du springer over. Hold PR fokuseret, note issue nummer, tilføje tests eller forklare fravær, dokument adfærd ændringer/risici omfatte redigerede logfiler / screenshots som bevis, og køre korrekt validering før indsendelse.
