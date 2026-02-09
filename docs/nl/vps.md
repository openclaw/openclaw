---
summary: "VPS-hostinghub voor OpenClaw (Oracle/Fly/Hetzner/GCP/exe.dev)"
read_when:
  - Je wilt de Gateway in de cloud draaien
  - Je hebt een snelle kaart van VPS-/hostinggidsen nodig
title: "VPS-hosting"
---

# VPS-hosting

Deze hub verwijst naar de ondersteunde VPS-/hostinggidsen en legt op hoofdlijnen uit
hoe cloudimplementaties werken.

## Kies een provider

- **Railway** (one‑click + browserinstallatie): [Railway](/install/railway)
- **Northflank** (one‑click + browserinstallatie): [Northflank](/install/northflank)
- **Oracle Cloud (Always Free)**: [Oracle](/platforms/oracle) — $0/maand (Always Free, ARM; capaciteit/aanmelding kan grillig zijn)
- **Fly.io**: [Fly.io](/install/fly)
- **Hetzner (Docker)**: [Hetzner](/install/hetzner)
- **GCP (Compute Engine)**: [GCP](/install/gcp)
- **exe.dev** (VM + HTTPS-proxy): [exe.dev](/install/exe-dev)
- **AWS (EC2/Lightsail/free tier)**: werkt ook goed. Videogids:
  [https://x.com/techfrenAJ/status/2014934471095812547](https://x.com/techfrenAJ/status/2014934471095812547)

## Hoe cloudopstellingen werken

- De **Gateway draait op de VPS** en beheert status + werkruimte.
- Je maakt verbinding vanaf je laptop/telefoon via de **Control UI** of **Tailscale/SSH**.
- Behandel de VPS als de bron van waarheid en **maak back-ups** van de status + werkruimte.
- Veilige standaard: houd de Gateway op loopback en krijg toegang via een SSH-tunnel of Tailscale Serve.
  Als je bindt aan `lan`/`tailnet`, vereis dan `gateway.auth.token` of `gateway.auth.password`.

Toegang op afstand: [Gateway remote](/gateway/remote)  
Platformshub: [Platforms](/platforms)

## Nodes gebruiken met een VPS

Je kunt de Gateway in de cloud houden en **nodes** koppelen op je lokale apparaten
(Mac/iOS/Android/headless). Nodes bieden lokale scherm-/camera-/canvas- en `system.run`-
mogelijkheden terwijl de Gateway in de cloud blijft.

Documentatie: [Nodes](/nodes), [Nodes CLI](/cli/nodes)
