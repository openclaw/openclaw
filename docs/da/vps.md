---
summary: "VPS-hostinghub til OpenClaw (Oracle/Fly/Hetzner/GCP/exe.dev)"
read_when:
  - Du vil køre Gateway i skyen
  - Du har brug for et hurtigt overblik over VPS-/hostingguider
title: "VPS-hosting"
x-i18n:
  source_path: vps.md
  source_hash: 96593a1550b56040
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:43Z
---

# VPS-hosting

Denne hub linker til de understøttede VPS-/hostingguider og forklarer på et
overordnet niveau, hvordan cloud-implementeringer fungerer.

## Vælg en udbyder

- **Railway** (one‑click + opsætning i browser): [Railway](/install/railway)
- **Northflank** (one‑click + opsætning i browser): [Northflank](/install/northflank)
- **Oracle Cloud (Always Free)**: [Oracle](/platforms/oracle) — $0/måned (Always Free, ARM; kapacitet/tilmelding kan være lidt ustabil)
- **Fly.io**: [Fly.io](/install/fly)
- **Hetzner (Docker)**: [Hetzner](/install/hetzner)
- **GCP (Compute Engine)**: [GCP](/install/gcp)
- **exe.dev** (VM + HTTPS-proxy): [exe.dev](/install/exe-dev)
- **AWS (EC2/Lightsail/free tier)**: fungerer også fint. Videoguide:
  [https://x.com/techfrenAJ/status/2014934471095812547](https://x.com/techfrenAJ/status/2014934471095812547)

## Sådan fungerer cloud-opsætninger

- **Gateway kører på VPS’en** og ejer state + workspace.
- Du forbinder fra din laptop/telefon via **Control UI** eller **Tailscale/SSH**.
- Betragt VPS’en som sandhedskilden og **tag backup** af state + workspace.
- Sikker standard: hold Gateway på loopback og få adgang via SSH-tunnel eller Tailscale Serve.
  Hvis du binder til `lan`/`tailnet`, kræv `gateway.auth.token` eller `gateway.auth.password`.

Fjernadgang: [Gateway remote](/gateway/remote)  
Platform-hub: [Platforms](/platforms)

## Brug af nodes med en VPS

Du kan have Gateway i skyen og parre **nodes** på dine lokale enheder
(Mac/iOS/Android/headless). Nodes leverer lokale skærm-/kamera-/canvas- og `system.run`-
funktioner, mens Gateway forbliver i skyen.

Dokumentation: [Nodes](/nodes), [Nodes CLI](/cli/nodes)
