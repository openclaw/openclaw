---
summary: "VPS-Hosting-Hub für OpenClaw (Oracle/Fly/Hetzner/GCP/exe.dev)"
read_when:
  - Sie möchten den Gateway in der Cloud betreiben
  - Sie benötigen eine schnelle Übersicht über VPS-/Hosting-Anleitungen
title: "VPS-Hosting"
---

# VPS-Hosting

Dieser Hub verweist auf die unterstützten VPS-/Hosting-Anleitungen und erklärt
auf hoher Ebene, wie Cloud-Bereitstellungen funktionieren.

## Anbieter auswählen

- **Railway** (One‑Click + Einrichtung im Browser): [Railway](/install/railway)
- **Northflank** (One‑Click + Einrichtung im Browser): [Northflank](/install/northflank)
- **Oracle Cloud (Always Free)**: [Oracle](/platforms/oracle) — 0 $/Monat (Always Free, ARM; Kapazität/Registrierung kann etwas heikel sein)
- **Fly.io**: [Fly.io](/install/fly)
- **Hetzner (Docker)**: [Hetzner](/install/hetzner)
- **GCP (Compute Engine)**: [GCP](/install/gcp)
- **exe.dev** (VM + HTTPS‑Proxy): [exe.dev](/install/exe-dev)
- **AWS (EC2/Lightsail/Free Tier)**: funktioniert ebenfalls sehr gut. Video‑Anleitung:
  [https://x.com/techfrenAJ/status/2014934471095812547](https://x.com/techfrenAJ/status/2014934471095812547)

## Wie Cloud-Setups funktionieren

- Der **Gateway läuft auf dem VPS** und verwaltet Zustand + Workspace.
- Sie verbinden sich von Ihrem Laptop/Telefon über die **Control‑UI** oder **Tailscale/SSH**.
- Behandeln Sie den VPS als Single Source of Truth und **sichern** Sie Zustand + Workspace.
- Sicherer Standard: Halten Sie den Gateway auf local loopback und greifen Sie über einen SSH‑Tunnel oder Tailscale Serve zu.
  Wenn Sie an `lan`/`tailnet` binden, verlangen Sie `gateway.auth.token` oder `gateway.auth.password`.

Remote‑Zugriff: [Gateway remote](/gateway/remote)  
Plattformen‑Hub: [Platforms](/platforms)

## Verwendung von Nodes mit einem VPS

Sie können den Gateway in der Cloud betreiben und **Nodes** auf Ihren lokalen Geräten
(Mac/iOS/Android/headless) koppeln. Nodes stellen lokale Bildschirm-/Kamera-/Canvas‑
und `system.run`‑Funktionen bereit, während der Gateway in der Cloud verbleibt.

Dokumentation: [Nodes](/nodes), [Nodes CLI](/cli/nodes)
