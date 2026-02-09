---
summary: "Sanggunian ng CLI para sa `openclaw security` (pag-audit at pag-ayos ng mga karaniwang security footgun)"
read_when:
  - Gusto mong magpatakbo ng mabilisang security audit sa config/state
  - Gusto mong ilapat ang mga ligtas na mungkahing “fix” (chmod, paghihigpit ng mga default)
title: "seguridad"
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

Nagbabala ang audit kapag maraming DM sender ang nagbabahagi ng pangunahing session at inirerekomenda ang **secure DM mode**: `session.dmScope="per-channel-peer"` (o `per-account-channel-peer` para sa mga multi-account channel) para sa mga shared inbox.
Nagbibigay din ito ng babala kapag ang maliliit na modelo (`<=300B`) ay ginagamit nang walang sandboxing at may naka-enable na web/browser tools.
