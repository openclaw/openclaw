---
summary: "CLI-referens för `openclaw security` (granska och åtgärda vanliga säkerhetsfallgropar)"
read_when:
  - Du vill köra en snabb säkerhetsgranskning av konfig/tillstånd
  - Du vill tillämpa säkra ”fix”-förslag (chmod, skärpa standardinställningar)
title: "säkerhet"
x-i18n:
  source_path: cli/security.md
  source_hash: 96542b4784e53933
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:16:45Z
---

# `openclaw security`

Säkerhetsverktyg (granskning + valfria åtgärder).

Relaterat:

- Säkerhetsguide: [Säkerhet](/gateway/security)

## Granskning

```bash
openclaw security audit
openclaw security audit --deep
openclaw security audit --fix
```

Granskningen varnar när flera DM-avsändare delar huvudsessionen och rekommenderar **säkert DM-läge**: `session.dmScope="per-channel-peer"` (eller `per-account-channel-peer` för kanaler med flera konton) för delade inkorgar.
Den varnar också när små modeller (`<=300B`) används utan sandboxing och med webb-/webbläsarverktyg aktiverade.
