---
summary: "VPS hosting hub para sa OpenClaw (Oracle/Fly/Hetzner/GCP/exe.dev)"
read_when:
  - Gusto mong patakbuhin ang Gateway sa cloud
  - Kailangan mo ng mabilisang mapa ng mga gabay sa VPS/hosting
title: "VPS Hosting"
---

# VPS hosting

Ang hub na ito ay nagli-link sa mga suportadong gabay sa VPS/hosting at ipinapaliwanag kung paano gumagana ang mga cloud deployment sa mataas na antas.

## Pumili ng provider

- **Railway** (one‑click + browser setup): [Railway](/install/railway)
- **Northflank** (one‑click + browser setup): [Northflank](/install/northflank)
- **Oracle Cloud (Always Free)**: [Oracle](/platforms/oracle) — $0/buwan (Always Free, ARM; maaaring maging pihikan ang kapasidad/pag-signup)
- **Fly.io**: [Fly.io](/install/fly)
- **Hetzner (Docker)**: [Hetzner](/install/hetzner)
- **GCP (Compute Engine)**: [GCP](/install/gcp)
- **exe.dev** (VM + HTTPS proxy): [exe.dev](/install/exe-dev)
- **AWS (EC2/Lightsail/free tier)**: works well too. Video guide:
  [https://x.com/techfrenAJ/status/2014934471095812547](https://x.com/techfrenAJ/status/2014934471095812547)

## Paano gumagana ang mga cloud setup

- Ang **Gateway ay tumatakbo sa VPS** at may-ari ng state + workspace.
- Kumokonek ka mula sa iyong laptop/phone gamit ang **Control UI** o **Tailscale/SSH**.
- Ituring ang VPS bilang source of truth at **i-back up** ang state + workspace.
- Secure na default: panatilihin ang Gateway sa loopback at i-access ito sa pamamagitan ng SSH tunnel o Tailscale Serve.
  If you bind to `lan`/`tailnet`, require `gateway.auth.token` or `gateway.auth.password`.

Remote access: [Gateway remote](/gateway/remote)  
Platforms hub: [Platforms](/platforms)

## Paggamit ng mga node kasama ang VPS

Maaari mong panatilihin ang Gateway sa cloud at ipares ang mga **node** sa iyong mga lokal na device
(Mac/iOS/Android/headless). Nagbibigay ang mga Node ng lokal na screen/camera/canvas at mga kakayahan ng `system.run` habang nananatili ang Gateway sa cloud.

Docs: [Nodes](/nodes), [Nodes CLI](/cli/nodes)
