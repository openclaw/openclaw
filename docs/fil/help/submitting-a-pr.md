---
summary: "Paano magsumite ng high-signal na PR"
title: "Pagsusumite ng PR"
x-i18n:
  source_path: help/submitting-a-pr.md
  source_hash: 277b0f51b948d1a9
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:45:32Z
---

Madaling i-review ang magagandang PR: dapat mabilis na maunawaan ng mga reviewer ang intensyon, ma-verify ang behavior, at ma-merge ang mga pagbabago nang ligtas. Saklaw ng gabay na ito ang mga maigsi at high-signal na submission para sa review ng tao at ng LLM.

## Ano ang bumubuo sa isang magandang PR

- [ ] Ipaliwanag ang problema, kung bakit ito mahalaga, at ang pagbabago.
- [ ] Panatilihing nakatuon ang mga pagbabago. Iwasan ang malalawak na refactor.
- [ ] Ibuod ang mga pagbabagong nakikita ng user/config/default.
- [ ] Ilista ang test coverage, mga skip, at mga dahilan.
- [ ] Magdagdag ng ebidensya: mga log, screenshot, o recording (UI/UX).
- [ ] Code word: ilagay ang “lobster-biscuit” sa PR description kung nabasa mo ang gabay na ito.
- [ ] Patakbuhin/ayusin ang mga kaugnay na `pnpm` command bago gumawa ng PR.
- [ ] Maghanap sa codebase at GitHub ng kaugnay na functionality/isyu/fix.
- [ ] I-base ang mga claim sa ebidensya o obserbasyon.
- [ ] Magandang pamagat: pandiwa + saklaw + kinalabasan (hal., `Docs: add PR and issue templates`).

Maging maigsi; mas mahalaga ang maigsi na review kaysa sa grammar. Alisin ang anumang seksyong hindi naaangkop.

### Mga baseline validation command (patakbuhin/ayusin ang mga failure para sa iyong pagbabago)

- `pnpm lint`
- `pnpm check`
- `pnpm build`
- `pnpm test`
- Mga pagbabago sa protocol: `pnpm protocol:check`

## Progressive disclosure

- Itaas: buod/intensyon
- Susunod: mga pagbabago/panganib
- Susunod: test/beripikasyon
- Huli: implementasyon/ebidensya

## Mga karaniwang uri ng PR: mga detalye

- [ ] Fix: Magdagdag ng repro, root cause, beripikasyon.
- [ ] Feature: Magdagdag ng use case, behavior/demo/screenshot (UI).
- [ ] Refactor: Banggitin ang "walang pagbabago sa behavior", ilista kung ano ang inilipat/pinasimple.
- [ ] Chore: Sabihin kung bakit (hal., build time, CI, dependencies).
- [ ] Docs: Konteksto ng bago/pagkatapos, i-link ang na-update na page, patakbuhin ang `pnpm format`.
- [ ] Test: Anong gap ang natakpan; paano nito pinipigilan ang regressions.
- [ ] Perf: Magdagdag ng before/after na metrics, at paano sinukat.
- [ ] UX/UI: Mga screenshot/video, banggitin ang epekto sa accessibility.
- [ ] Infra/Build: Mga environment/beripikasyon.
- [ ] Security: Ibuod ang risk, repro, beripikasyon, walang sensitibong data. Mga claim na may batayan lamang.

## Checklist

- [ ] Malinaw na problema/intensyon
- [ ] Nakatuong saklaw
- [ ] Listahan ng mga pagbabago sa behavior
- [ ] Listahan at resulta ng mga test
- [ ] Mga hakbang sa manual test (kung naaangkop)
- [ ] Walang lihim/pribadong data
- [ ] Batay sa ebidensya

## Pangkalahatang PR Template

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

## Mga template ng uri ng PR (palitan ayon sa iyong uri)

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
