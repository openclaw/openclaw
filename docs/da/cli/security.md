---
summary: "CLI-reference for `openclaw security` (audit og udbedring af almindelige sikkerhedsfaldgruber)"
read_when:
  - Du vil køre en hurtig sikkerhedsaudit af konfiguration/tilstand
  - Du vil anvende sikre “fix”-forslag (chmod, strammere standardindstillinger)
title: "sikkerhed"
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

Revisionen advarer når flere DM-afsendere deler hovedsessionen og anbefaler **sikker DM-tilstand**: `session.dmScope="per-channel-peer"` (eller `per-account-channel-peer` for multi-account kanaler) for delte indbakker.
Det advarer også, når små modeller (`<=300B`) bruges uden sandboxing og med web/browser værktøjer aktiveret.
