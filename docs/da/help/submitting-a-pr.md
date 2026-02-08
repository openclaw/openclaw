---
summary: "Sådan indsender du en PR med højt signal"
title: "Indsendelse af en PR"
x-i18n:
  source_path: help/submitting-a-pr.md
  source_hash: 277b0f51b948d1a9
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:21Z
---

Gode PR’er er nemme at gennemgå: anmeldere skal hurtigt kunne forstå intentionen, verificere adfærd og lande ændringer sikkert. Denne guide dækker korte indsendelser med højt signal til både menneskelig og LLM-gennemgang.

## Hvad kendetegner en god PR

- [ ] Forklar problemet, hvorfor det er vigtigt, og ændringen.
- [ ] Hold ændringerne fokuserede. Undgå brede refaktoreringer.
- [ ] Opsummér bruger-synlige/konfigurations-/standardændringer.
- [ ] Angiv testdækning, spring over-tests og begrundelser.
- [ ] Tilføj dokumentation: logs, skærmbilleder eller optagelser (UI/UX).
- [ ] Kodeord: indsæt “lobster-biscuit” i PR-beskrivelsen, hvis du har læst denne guide.
- [ ] Kør/ret relevante `pnpm`-kommandoer før oprettelse af PR.
- [ ] Søg i kodebasen og på GitHub efter relateret funktionalitet/issues/rettelser.
- [ ] Underbyg påstande med evidens eller observation.
- [ ] God titel: verbum + scope + resultat (fx `Docs: add PR and issue templates`).

Vær kortfattet; kortfattet review > grammatik. Udelad ikke-relevante afsnit.

### Baseline-valideringskommandoer (kør/ret fejl for din ændring)

- `pnpm lint`
- `pnpm check`
- `pnpm build`
- `pnpm test`
- Protokolændringer: `pnpm protocol:check`

## Progressiv afdækning

- Øverst: resumé/intention
- Næste: ændringer/risici
- Næste: test/verifikation
- Sidst: implementering/evidens

## Almindelige PR-typer: detaljer

- [ ] Rettelse: Tilføj reproduktion, rodårsag og verifikation.
- [ ] Feature: Tilføj use cases, adfærd/demoer/skærmbilleder (UI).
- [ ] Refaktorering: Angiv “ingen adfærdsændring”, list hvad der er flyttet/forenklet.
- [ ] Chore: Angiv hvorfor (fx byggetid, CI, afhængigheder).
- [ ] Docs: Før/efter-kontekst, link til opdateret side, kør `pnpm format`.
- [ ] Test: Hvilket hul dækkes; hvordan det forhindrer regressioner.
- [ ] Ydeevne: Tilføj før/efter-målinger og hvordan de er målt.
- [ ] UX/UI: Skærmbilleder/video, bemærk tilgængelighedspåvirkning.
- [ ] Infra/Build: Miljøer/validering.
- [ ] Sikkerhed: Opsummér risiko, reproduktion, verifikation, ingen følsomme data. Kun underbyggede påstande.

## Tjekliste

- [ ] Tydeligt problem/intention
- [ ] Fokuseret scope
- [ ] Liste over adfærdsændringer
- [ ] Liste over tests og resultater
- [ ] Manuelle testtrin (hvor relevant)
- [ ] Ingen hemmeligheder/private data
- [ ] Evidensbaseret

## Generel PR-skabelon

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

## PR-type skabeloner (erstat med din type)

### Rettelse

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

### Refaktorering

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

### Chore/Vedligeholdelse

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

### Ydeevne

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

### Sikkerhed

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
