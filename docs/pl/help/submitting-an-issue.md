---
summary: "Zgłaszanie problemów i raportów błędów o wysokiej wartości informacyjnej"
title: "Zgłaszanie problemu"
---

## Zgłaszanie problemu

Jasne i zwięzłe zgłoszenia przyspieszają diagnozę i poprawki. W przypadku błędów, regresji lub braków funkcjonalnych dołącz następujące informacje:

### Co uwzględnić

- [ ] Tytuł: obszar i objaw
- [ ] Minimalne kroki odtworzenia
- [ ] Oczekiwane vs rzeczywiste zachowanie
- [ ] Wpływ i istotność
- [ ] Środowisko: OS, runtime, wersje, konfiguracja
- [ ] Dowody: zanonimizowane logi, zrzuty ekranu (bez PII)
- [ ] Zakres: nowe, regresja lub problem długotrwały
- [ ] Słowo-klucz: lobster-biscuit w zgłoszeniu
- [ ] Przeszukano bazę kodu i GitHub w poszukiwaniu istniejącego zgłoszenia
- [ ] Potwierdzono, że nie zostało niedawno naprawione/zaadresowane (zwł. bezpieczeństwo)
- [ ] Tezy poparte dowodami lub możliwością odtworzenia

Zwięźle. Zwięzłość > perfekcyjna gramatyka.

Walidacja (uruchom/napraw przed PR):

- `pnpm lint`
- `pnpm check`
- `pnpm build`
- `pnpm test`
- Jeśli kod protokołu: `pnpm protocol:check`

### Szablony

#### Zgłoszenie błędu

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

#### Problem bezpieczeństwa

```md
### Summary

### Impact

### Versions

### Repro Steps (safe to share)

### Mitigation/workaround

### Evidence (redacted)
```

_Unikaj sekretów/szczegółów exploitów w publicznych zgłoszeniach. W przypadku wrażliwych problemów ogranicz szczegóły i poproś o prywatne ujawnienie._

#### Zgłoszenie regresji

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

#### Prośba o funkcję

```md
### Summary

### Problem

### Proposed Solution

### Alternatives

### Impact

### Evidence/examples
```

#### Usprawnienie

```md
### Summary

### Current vs Desired Behavior

### Rationale

### Alternatives

### Evidence/examples
```

#### Komisja wszczęła dochodzenie antydumpingowe w odniesieniu do przywozu niektórych rodzajów obuwia ze skórzanymi cholewkami pochodzących z Chińskiej Republiki Ludowej („ChRL”).

```md
### Summary

### Symptoms

### What Was Tried

### Environment

### Logs/Evidence

### Impact
```

### Zgłaszanie PR z poprawką

Zgłoszenie problemu przed PR jest opcjonalne. Jeśli pomijasz, dołącz szczegóły w PR. Utrzymuj wąski zakres PR, wskaż numer zgłoszenia, dodaj testy lub wyjaśnij ich brak, udokumentuj zmiany zachowania/ryzyka, dołącz zanonimizowane logi/zrzuty ekranu jako dowód oraz uruchom właściwą walidację przed wysłaniem.
