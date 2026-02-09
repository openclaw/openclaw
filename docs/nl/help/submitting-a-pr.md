---
summary: "Hoe je een PR met hoge signaalwaarde indient"
title: "Een PR indienen"
---

Goede PR’s zijn eenvoudig te reviewen: reviewers moeten snel de intentie begrijpen, het gedrag kunnen verifiëren en wijzigingen veilig kunnen landen. Deze gids behandelt beknopte inzendingen met hoge signaalwaarde voor menselijke en LLM-review.

## Wat maakt een goede PR

- [ ] Leg het probleem uit, waarom het ertoe doet en wat de wijziging is.
- [ ] Houd wijzigingen gefocust. Vermijd brede refactors.
- [ ] Vat gebruikerszichtbare/configuratie/standaardwijzigingen samen.
- [ ] Vermeld testdekking, overslagen en redenen.
- [ ] Voeg bewijs toe: logs, screenshots of opnames (UI/UX).
- [ ] Codewoord: zet “lobster-biscuit” in de PR-beschrijving als je deze gids hebt gelezen.
- [ ] Voer relevante `pnpm`-opdrachten uit en los fouten op vóór het aanmaken van de PR.
- [ ] Doorzoek de codebase en GitHub op gerelateerde functionaliteit/issues/fixes.
- [ ] Baseer beweringen op bewijs of observatie.
- [ ] Goede titel: werkwoord + scope + resultaat (bijv. `Docs: add PR and issue templates`).

Wees beknopt; beknopte review > grammatica. Laat niet-toepasselijke secties weg.

### Baseline validatie-opdrachten (uitvoeren/oplossen bij fouten voor jouw wijziging)

- `pnpm lint`
- `pnpm check`
- `pnpm build`
- `pnpm test`
- Protocolwijzigingen: `pnpm protocol:check`

## Progressieve onthulling

- Bovenaan: samenvatting/intent
- Daarna: wijzigingen/risico’s
- Daarna: test/verificatie
- Als laatste: implementatie/bewijs

## Veelvoorkomende PR-typen: specifics

- [ ] Fix: Voeg repro, root cause en verificatie toe.
- [ ] Feature: Voeg use cases, gedrag/demo’s/screenshots (UI) toe.
- [ ] Refactor: Vermeld “geen gedragswijziging”, lijst wat is verplaatst/vereenvoudigd.
- [ ] Chore: Geef aan waarom (bijv. buildtijd, CI, afhankelijkheden).
- [ ] Docs: Voor/na-context, link naar bijgewerkte pagina, voer `pnpm format` uit.
- [ ] Test: Welk gat wordt gedicht; hoe dit regressies voorkomt.
- [ ] Perf: Voeg voor/na-metrics toe en hoe ze zijn gemeten.
- [ ] UX/UI: Screenshots/video, noteer impact op toegankelijkheid.
- [ ] Infra/Build: Omgevingen/validatie.
- [ ] Security: Vat risico samen, repro, verificatie, geen gevoelige data. Alleen onderbouwde claims.

## Checklist

- [ ] Duidelijk probleem/intent
- [ ] Gefocuste scope
- [ ] Lijst met gedragswijzigingen
- [ ] Lijst en resultaat van tests
- [ ] Handmatige teststappen (waar van toepassing)
- [ ] Geen geheimen/privégegevens
- [ ] Bewijsgebaseerd

## Algemene PR-sjabloon

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

## PR-type sjablonen (vervang door jouw type)

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

### Chore/Onderhoud

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
