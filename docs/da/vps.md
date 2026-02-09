---
summary: "VPS-hostinghub til OpenClaw (Oracle/Fly/Hetzner/GCP/exe.dev)"
read_when:
  - Du vil køre Gateway i skyen
  - Du har brug for et hurtigt overblik over VPS-/hostingguider
title: "VPS-hosting"
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
- **AWS (EC2/Lightsail/free tier)**: fungerer også godt. Videoguide:
  [https://x.com/techfrenAJ/status/2014934471095812547](https://x.com/techfrenAJ/status/2014934471095812547)

## Sådan fungerer cloud-opsætninger

- **Gateway kører på VPS’en** og ejer state + workspace.
- Du forbinder fra din laptop/telefon via **Control UI** eller **Tailscale/SSH**.
- Betragt VPS’en som sandhedskilden og **tag backup** af state + workspace.
- Sikker standard: Hold porten på loopback og få adgang til den via SSH-tunnelen eller Tailscale Serve.
  Hvis du binder til `lan`/`tailnet`, skal du bruge `gateway.auth.token` eller `gateway.auth.password`.

Fjernadgang: [Gateway remote](/gateway/remote)  
Platform-hub: [Platforms](/platforms)

## Brug af nodes med en VPS

Du kan holde porten i skyen og parre **noder** på dine lokale enheder
(Mac/iOS/Android/headles). Knuder giver lokal skærm/kamera/lærred og `system.run`
kapaciteter, mens Gateway forbliver i skyen.

Dokumentation: [Nodes](/nodes), [Nodes CLI](/cli/nodes)
