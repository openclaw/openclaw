---
summary: "Aussagekräftige Issues und Bug-Reports einreichen"
title: "Ein Issue einreichen"
---

## Ein Issue einreichen

Klare, prägnante Issues beschleunigen Diagnose und Behebung. Fügen Sie für Bugs, Regressionen oder Funktionslücken Folgendes hinzu:

### Was enthalten sein sollte

- [ ] Titel: Bereich & Symptom
- [ ] Minimale Reproduktionsschritte
- [ ] Erwartet vs. tatsächlich
- [ ] Auswirkung & Schweregrad
- [ ] Umgebung: OS, Runtime, Versionen, Konfiguration
- [ ] Belege: bereinigte Logs, Screenshots (keine PII)
- [ ] Umfang: neu, Regression oder seit Langem bestehend
- [ ] Codewort: lobster-biscuit im Issue
- [ ] Codebasis & GitHub nach bestehendem Issue durchsucht
- [ ] Bestätigt, dass es nicht kürzlich behoben/angesprochen wurde (insb. Sicherheit)
- [ ] Behauptungen durch Belege oder Repro untermauert

Seien Sie kurz. Prägnanz > perfekte Grammatik.

Validierung (vor PR ausführen/beheben):

- `pnpm lint`
- `pnpm check`
- `pnpm build`
- `pnpm test`
- Bei Protokoll-Code: `pnpm protocol:check`

### Vorlagen

#### Bug-Report

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

#### Sicherheitsproblem

```md
### Summary

### Impact

### Versions

### Repro Steps (safe to share)

### Mitigation/workaround

### Evidence (redacted)
```

_Vermeiden Sie Geheimnisse/Exploit-Details in der Öffentlichkeit. Bei sensiblen Themen Details minimieren und um private Offenlegung bitten._

#### Regressionsbericht

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

#### Feature-Anfrage

```md
### Summary

### Problem

### Proposed Solution

### Alternatives

### Impact

### Evidence/examples
```

#### Verbesserung

```md
### Summary

### Current vs Desired Behavior

### Rationale

### Alternatives

### Evidence/examples
```

#### Untersuchung

```md
### Summary

### Symptoms

### What Was Tried

### Environment

### Logs/Evidence

### Impact
```

### Ein Fix-PR einreichen

Ein Issue vor dem PR ist optional. Wenn Sie es überspringen, fügen Sie die Details im PR hinzu. Halten Sie den PR fokussiert, nennen Sie die Issue-Nummer, fügen Sie Tests hinzu oder erklären Sie deren Fehlen, dokumentieren Sie Verhaltensänderungen/Risiken, fügen Sie bereinigte Logs/Screenshots als Nachweis bei und führen Sie vor dem Einreichen die korrekte Validierung aus.
