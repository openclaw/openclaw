---
summary: "Wie man eine hohe PR sendet"
title: "PR einreichen"
---

Gute PRs sind leicht zu prüfen: Reviewer sollten die Absicht schnell verstehen, das Verhalten verifizieren und Änderungen sicher zusammenführen können. Dieser Leitfaden behandelt prägnante PRs mit hoher Aussagekraft für menschliche und LLM‑Reviews.

## Was einen guten PR ausmacht

- [ ] Erklären Sie das Problem, warum es wichtig ist, und die Änderung.
- [ ] Halten Sie Änderungen fokussiert. Vermeiden Sie breite Refactorings.
- [ ] Fassen Sie für Nutzer sichtbare/konfigurationsbezogene/Standard‑Änderungen zusammen.
- [ ] Listen Sie Testabdeckung, Überspringungen und Gründe auf.
- [ ] Fügen Sie Belege hinzu: Logs, Screenshots oder Aufzeichnungen (UI/UX).
- [ ] Codewort: Fügen Sie „lobster-biscuit“ in die PR‑Beschreibung ein, wenn Sie diesen Leitfaden gelesen haben.
- [ ] Führen Sie vor dem Erstellen des PRs relevante `pnpm`‑Befehle aus und beheben Sie Fehler.
- [ ] Durchsuchen Sie Codebasis und GitHub nach verwandter Funktionalität/Issues/Fixes.
- [ ] Stützen Sie Aussagen auf Belege oder Beobachtungen.
- [ ] Guter Titel: Verb + Umfang + Ergebnis (z. B. `Docs: add PR and issue templates`).

Seien Sie prägnant; prägnante Reviews > Grammatik. Lassen Sie nicht zutreffende Abschnitte weg.

### Basis‑Validierungsbefehle (führen Sie sie aus und beheben Sie Fehler für Ihre Änderung)

- `pnpm lint`
- `pnpm check`
- `pnpm build`
- `pnpm test`
- Protokolländerungen: `pnpm protocol:check`

## Progressive Offenlegung

- Oben: Zusammenfassung/Absicht
- Danach: Änderungen/Risiken
- Danach: Tests/Verifikation
- Zuletzt: Implementierung/Belege

## Häufige PR‑Typen: Besonderheiten

- [ ] Fix: Repro, Grundursache, Verifikation hinzufügen.
- [ ] Feature: Anwendungsfälle, Verhalten/Demos/Screenshots (UI) hinzufügen.
- [ ] Refactor: „keine Verhaltensänderung“ angeben, auflisten, was verschoben/vereinfacht wurde.
- [ ] Chore: Begründung angeben (z. B. Build‑Zeit, CI, Abhängigkeiten).
- [ ] Docs: Vorher/Nachher‑Kontext, aktualisierte Seite verlinken, `pnpm format` ausführen.
- [ ] Test: Welche Lücke abgedeckt wird; wie Regressionen verhindert werden.
- [ ] Perf: Vorher/Nachher‑Metriken hinzufügen und Messmethode angeben.
- [ ] UX/UI: Screenshots/Video, Auswirkungen auf Barrierefreiheit vermerken.
- [ ] Infra/Build: Umgebungen/Validierung.
- [ ] Security: Risiko, Repro, Verifikation zusammenfassen, keine sensiblen Daten. Nur fundierte Aussagen.

## Checkliste

- [ ] Klarer Problem-/Intent
- [ ] Fokussierter Umfang
- [ ] Verhaltensänderungen aufgelistet
- [ ] Tests und Ergebnisse aufgelistet
- [ ] Manuelle Testschritte (falls zutreffend)
- [ ] Keine Geheimnisse/privaten Daten
- [ ] Evidenzbasiert

## Allgemeine PR‑Vorlage

```md
#### Summary

#### Behavior Changes

#### Codebase and GitHub Search

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort (self-reported):
- Agent notes (optional, cite evidence):
```

## PR‑Typ‑Vorlagen (durch Ihren Typ ersetzen)

### Fix

```md
#### Summary

#### Repro Steps

#### Root Cause

#### Behavior Changes

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### Feature

```md
#### Summary

#### Use Cases

#### Behavior Changes

#### Existing Functionality Check

- [ ] I searched the codebase for existing functionality.
      Searches performed (1-3 bullets):
  -
  -

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### Refactor

```md
#### Summary

#### Scope

#### No Behavior Change Statement

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### Chore/Maintenance

```md
#### Summary

#### Why This Matters

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### Docs

```md
#### Summary

#### Pages Updated

#### Before/After

#### Formatting

pnpm format

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### Test

```md
#### Summary

#### Gap Covered

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### Perf

```md
#### Summary

#### Baseline

#### After

#### Measurement Method

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### UX/UI

```md
#### Summary

#### Screenshots or Video

#### Accessibility Impact

#### Tests

#### Manual Testing

### Prerequisites

-

### Steps

1.
2. **Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### Infra/Build

```md
#### Summary

#### Environments Affected

#### Validation Steps

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### Security

```md
#### Summary

#### Risk Summary

#### Repro Steps

#### Mitigation or Fix

#### Verification

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```
