---
summary: "„Hub hostingu VPS dla OpenClaw (Oracle/Fly/Hetzner/GCP/exe.dev)”"
read_when:
  - Chcesz uruchomić Gateway w chmurze
  - Potrzebujesz szybkiej mapy przewodników VPS/hosting
title: "„Hosting VPS”"
---

# Hosting VPS

Ten hub zawiera linki do obsługiwanych przewodników VPS/hosting oraz wyjaśnia na wysokim poziomie,
jak działają wdrożenia w chmurze.

## Wybierz dostawcę

- **Railway** (jedno kliknięcie + konfiguracja w przeglądarce): [Railway](/install/railway)
- **Northflank** (jedno kliknięcie + konfiguracja w przeglądarce): [Northflank](/install/northflank)
- **Oracle Cloud (Always Free)**: [Oracle](/platforms/oracle) — 0 USD/miesiąc (Always Free, ARM; pojemność/rejestracja bywa kapryśna)
- **Fly.io**: [Fly.io](/install/fly)
- **Hetzner (Docker)**: [Hetzner](/install/hetzner)
- **GCP (Compute Engine)**: [GCP](/install/gcp)
- **exe.dev** (VM + proxy HTTPS): [exe.dev](/install/exe-dev)
- **AWS (EC2/Lightsail/free tier)**: również działa bardzo dobrze. Przewodnik wideo:
  [https://x.com/techfrenAJ/status/2014934471095812547](https://x.com/techfrenAJ/status/2014934471095812547)

## Jak działają konfiguracje w chmurze

- **Gateway działa na VPS** i zarządza stanem oraz obszarem roboczym.
- Łączysz się z laptopa/telefonu przez **Control UI** lub **Tailscale/SSH**.
- Traktuj VPS jako źródło prawdy i **wykonuj kopie zapasowe** stanu oraz obszaru roboczego.
- Bezpieczne ustawienie domyślne: trzymaj Gateway na loopback i uzyskuj dostęp przez tunel SSH lub Tailscale Serve.
  Jeśli zbindowujesz do `lan`/`tailnet`, wymagaj `gateway.auth.token` lub `gateway.auth.password`.

Zdalny dostęp: [Gateway remote](/gateway/remote)  
Hub platform: [Platforms](/platforms)

## Używanie węzłów z VPS

Możesz utrzymywać Gateway w chmurze i parować **węzły** na lokalnych urządzeniach
(Mac/iOS/Android/headless). Węzły zapewniają lokalny ekran/kamerę/płótno oraz możliwości `system.run`,
podczas gdy Gateway pozostaje w chmurze.

Dokumentacja: [Nodes](/nodes), [Nodes CLI](/cli/nodes)
