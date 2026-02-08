---
summary: "Pagsusumite ng mga isyung may mataas na signal at bug report"
title: "Pagsusumite ng Isyu"
x-i18n:
  source_path: help/submitting-an-issue.md
  source_hash: bcb33f05647e9f0d
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:45:29Z
---

## Pagsusumite ng Isyu

Ang malinaw at maigsi na mga isyu ay nagpapabilis ng diagnosis at pag-aayos. Isama ang mga sumusunod para sa mga bug, regression, o kakulangan sa feature:

### Ano ang isasama

- [ ] Pamagat: area at sintomas
- [ ] Minimal na mga hakbang para ma-repro
- [ ] Inaasahan vs aktwal
- [ ] Epekto at tindi
- [ ] Environment: OS, runtime, mga bersyon, config
- [ ] Ebidensya: redacted na logs, screenshots (walang PII)
- [ ] Saklaw: bago, regression, o matagal na
- [ ] Code word: lobster-biscuit sa iyong isyu
- [ ] Naghahanap sa codebase at GitHub para sa umiiral na isyu
- [ ] Nakumpirmang hindi pa kamakailan naayos/natugunan (lalo na seguridad)
- [ ] Mga pahayag na suportado ng ebidensya o repro

Maging maikli. Mas mahalaga ang pagiging terse kaysa perpektong grammar.

Validation (patakbuhin/ayusin bago PR):

- `pnpm lint`
- `pnpm check`
- `pnpm build`
- `pnpm test`
- Kung protocol code: `pnpm protocol:check`

### Mga template

#### Bug report

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

#### Isyu sa seguridad

```md
### Summary

### Impact

### Versions

### Repro Steps (safe to share)

### Mitigation/workaround

### Evidence (redacted)
```

_Iwasan ang mga lihim/detalye ng exploit sa publiko. Para sa sensitibong mga isyu, bawasan ang detalye at humiling ng pribadong disclosure._

#### Regression report

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

#### Kahilingan sa feature

```md
### Summary

### Problem

### Proposed Solution

### Alternatives

### Impact

### Evidence/examples
```

#### Enhancement

```md
### Summary

### Current vs Desired Behavior

### Rationale

### Alternatives

### Evidence/examples
```

#### Investigation

```md
### Summary

### Symptoms

### What Was Tried

### Environment

### Logs/Evidence

### Impact
```

### Pagsusumite ng fix PR

Opsyonal ang isyu bago PR. Isama ang mga detalye sa PR kung lalaktawan. Panatilihing nakatuon ang PR, banggitin ang issue number, magdagdag ng mga test o ipaliwanag ang kawalan nito, idokumento ang mga pagbabago/panganib sa behavior, isama ang redacted na logs/screenshots bilang patunay, at patakbuhin ang tamang validation bago magsumite.
