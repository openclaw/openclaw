---
summary: "Pagsusumite ng mga isyung may mataas na signal at bug report"
title: "Pagsusumite ng Isyu"
---

## Pagsusumite ng Isyu

Clear, concise issues speed up diagnosis and fixes. Include the following for bugs, regressions, or feature gaps:

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

Be brief. Terseness > perfect grammar.

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

Para sa mga sensitibong isyu, bawasan ang detalye at humiling ng pribadong pagsisiwalat._ Opsyonal ang issue bago ang PR.

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

Mistral: `mistral/`… Include details in PR if skipping. Keep the PR focused, note issue number, add tests or explain absence, document behavior changes/risks, include redacted logs/screenshots as proof, and run proper validation before submitting.
