---
summary: "CLI-reference for `openclaw dns` (hjælpere til wide-area discovery)"
read_when:
  - Du vil have wide-area discovery (DNS-SD) via Tailscale + CoreDNS
  - You’re setting up split DNS for a custom discovery domain (example: openclaw.internal)
title: "dns"
---

# `openclaw dns`

DNS-hjælpere til opdagelse i store områder (Tailscale + CoreDNS). I øjeblikket fokuseret på macOS + Homebrew CoreDNS.

Relateret:

- Gateway discovery: [Discovery](/gateway/discovery)
- Konfiguration af wide-area discovery: [Configuration](/gateway/configuration)

## Opsætning

```bash
openclaw dns setup
openclaw dns setup --apply
```
