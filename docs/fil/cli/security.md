---
summary: "Sanggunian ng CLI para sa `openclaw security` (pag-audit at pag-ayos ng mga karaniwang security footgun)"
read_when:
  - Gusto mong magpatakbo ng mabilisang security audit sa config/state
  - Gusto mong ilapat ang mga ligtas na mungkahing “fix” (chmod, paghihigpit ng mga default)
title: "seguridad"
x-i18n:
  source_path: cli/security.md
  source_hash: 96542b4784e53933
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:45:14Z
---

# `openclaw security`

Mga security tool (audit + opsyonal na mga fix).

Kaugnay:

- Gabay sa seguridad: [Security](/gateway/security)

## Audit

```bash
openclaw security audit
openclaw security audit --deep
openclaw security audit --fix
```

Nagbibigay-babala ang audit kapag maraming DM sender ang nagbabahagi ng pangunahing session at nirerekomenda ang **secure DM mode**: `session.dmScope="per-channel-peer"` (o `per-account-channel-peer` para sa mga multi-account channel) para sa mga shared inbox.
Nagbibigay rin ito ng babala kapag ginagamit ang maliliit na model (`<=300B`) nang walang sandboxing at naka-enable ang mga web/browser tool.
