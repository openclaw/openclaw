---
summary: "VPS‑värdnav för OpenClaw (Oracle/Fly/Hetzner/GCP/exe.dev)"
read_when:
  - Du vill köra Gateway i molnet
  - Du behöver en snabb översikt över VPS-/värdnguider
title: "VPS‑värd"
---

# VPS‑värd

Denna hubb länkar till de stödda VPS-/värdnguiderna och förklarar hur
molndistributioner fungerar på en övergripande nivå.

## Välj en leverantör

- **Railway** (ett klick + webbläsarbaserad konfigurering): [Railway](/install/railway)
- **Northflank** (ett klick + webbläsarbaserad konfigurering): [Northflank](/install/northflank)
- **Oracle Cloud (Always Free)**: [Oracle](/platforms/oracle) — 0 $/månad (Always Free, ARM; kapacitet/registrering kan vara krånglig)
- **Fly.io**: [Fly.io](/install/fly)
- **Hetzner (Docker)**: [Hetzner](/install/hetzner)
- **GCP (Compute Engine)**: [GCP](/install/gcp)
- **exe.dev** (VM + HTTPS‑proxy): [exe.dev](/install/exe-dev)
- **AWS (EC2/Lightsail/free tier)**: fungerar bra också. Video guide:
  [https://x.com/techfrenAJ/status/2014934471095812547](https://x.com/techfrenAJ/status/2014934471095812547)

## Hur molnkonfigurationer fungerar

- **Gateway körs på VPS:en** och äger tillstånd + arbetsyta.
- Du ansluter från din laptop/telefon via **Control UI** eller **Tailscale/SSH**.
- Behandla VPS:en som sanningskälla och **säkerhetskopiera** tillstånd + arbetsyta.
- Säkra standard: håll Gateway på loopback och kom åt den via SSH-tunneln eller Tailscale Serve.
  Om du binder till `lan`/`tailnet`, behöver du `gateway.auth.token` eller `gateway.auth.password`.

Fjärråtkomst: [Gateway remote](/gateway/remote)  
Plattformshubb: [Platforms](/platforms)

## Använd noder med en VPS

Du kan behålla Gateway i molnet och parkoppla **noder** på dina lokala enheter
(Mac/iOS/Android/headless). Noder tillhandahåller lokal skärm/kamera/canvas och `system.run`
funktioner medan Gateway stannar i molnet.

Dokumentation: [Nodes](/nodes), [Nodes CLI](/cli/nodes)
