---
summary: "CLI-reference for `openclaw security` (audit og udbedring af almindelige sikkerhedsfaldgruber)"
read_when:
  - Du vil køre en hurtig sikkerhedsaudit af konfiguration/tilstand
  - Du vil anvende sikre “fix”-forslag (chmod, strammere standardindstillinger)
title: "sikkerhed"
x-i18n:
  source_path: cli/security.md
  source_hash: 96542b4784e53933
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:01Z
---

# `openclaw security`

Sikkerhedsværktøjer (audit + valgfrie rettelser).

Relateret:

- Sikkerhedsguide: [Security](/gateway/security)

## Audit

```bash
openclaw security audit
openclaw security audit --deep
openclaw security audit --fix
```

Auditen advarer, når flere DM-afsendere deler hovedsessionen, og anbefaler **sikker DM-tilstand**: `session.dmScope="per-channel-peer"` (eller `per-account-channel-peer` for kanaler med flere konti) for delte indbakker.
Den advarer også, når små modeller (`<=300B`) bruges uden sandboxing og med web-/browserværktøjer aktiveret.
