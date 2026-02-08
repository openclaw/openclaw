---
summary: "Hur du skickar in en PR med hög signal"
title: "Skicka in en PR"
x-i18n:
  source_path: help/submitting-a-pr.md
  source_hash: 277b0f51b948d1a9
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:17:30Z
---

Bra PR:er är lätta att granska: granskare ska snabbt förstå avsikten, verifiera beteendet och slå samman ändringar säkert. Den här guiden täcker kortfattade bidrag med hög signal för mänsklig och LLM-granskning.

## Vad som gör en bra PR

- [ ] Förklara problemet, varför det spelar roll och ändringen.
- [ ] Håll ändringar fokuserade. Undvik breda refaktoriseringar.
- [ ] Sammanfatta ändringar som är synliga för användare/konfig/standardvärden.
- [ ] Lista testtäckning, hoppade tester och skäl.
- [ ] Lägg till bevis: loggar, skärmbilder eller inspelningar (UI/UX).
- [ ] Kodord: lägg ”lobster-biscuit” i PR-beskrivningen om du har läst den här guiden.
- [ ] Kör/åtgärda relevanta `pnpm`-kommandon innan du skapar PR.
- [ ] Sök i kodbasen och på GitHub efter relaterad funktionalitet/ärenden/fixar.
- [ ] Basera påståenden på bevis eller observation.
- [ ] Bra titel: verb + omfattning + utfall (t.ex. `Docs: add PR and issue templates`).

Var kortfattad; kortfattad granskning > grammatik. Utelämna avsnitt som inte är tillämpliga.

### Baslinjevalideringskommandon (kör/åtgärda fel för din ändring)

- `pnpm lint`
- `pnpm check`
- `pnpm build`
- `pnpm test`
- Protokolländringar: `pnpm protocol:check`

## Progressiv informationsnivå

- Överst: sammanfattning/avsikt
- Därefter: ändringar/risker
- Därefter: test/verifiering
- Sist: implementation/bevis

## Vanliga PR-typer: detaljer

- [ ] Fix: Lägg till reproduktion, grundorsak, verifiering.
- [ ] Feature: Lägg till användningsfall, beteende/demon/skärmbilder (UI).
- [ ] Refactor: Ange ”ingen beteendeförändring”, lista vad som flyttats/förenklats.
- [ ] Chore: Ange varför (t.ex. byggtid, CI, beroenden).
- [ ] Docs: Före-/efterkontext, länka uppdaterad sida, kör `pnpm format`.
- [ ] Test: Vilket gap täcks; hur det förhindrar regressioner.
- [ ] Perf: Lägg till före-/efter-mått och hur de mättes.
- [ ] UX/UI: Skärmbilder/video, notera tillgänglighetspåverkan.
- [ ] Infra/Build: Miljöer/validering.
- [ ] Security: Sammanfatta risk, reproduktion, verifiering, inga känsliga data. Endast välgrundade påståenden.

## Checklista

- [ ] Tydligt problem/avsikt
- [ ] Fokuserad omfattning
- [ ] Lista beteendeförändringar
- [ ] Lista och resultat av tester
- [ ] Manuella teststeg (när tillämpligt)
- [ ] Inga hemligheter/privata data
- [ ] Evidensbaserat

## Allmän PR-mall

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

## PR-typmallar (ersätt med din typ)

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

### Chore/Underhåll

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
