---
summary: "Hub d’hébergement VPS pour OpenClaw (Oracle/Fly/Hetzner/GCP/exe.dev)"
read_when:
  - Vous souhaitez exécuter le Gateway (passerelle) dans le cloud
  - Vous avez besoin d’une vue d’ensemble rapide des guides VPS/hébergement
title: "Hébergement VPS"
---

# Hébergement VPS

Ce hub renvoie vers les guides VPS/hébergement pris en charge et explique, à un niveau général, le fonctionnement des déploiements cloud.

## Choisir un fournisseur

- **Railway** (déploiement en un clic + configuration via le navigateur) : [Railway](/install/railway)
- **Northflank** (déploiement en un clic + configuration via le navigateur) : [Northflank](/install/northflank)
- **Oracle Cloud (Always Free)** : [Oracle](/platforms/oracle) — 0 $/mois (Always Free, ARM ; capacité/inscription parfois capricieuses)
- **Fly.io** : [Fly.io](/install/fly)
- **Hetzner (Docker)** : [Hetzner](/install/hetzner)
- **GCP (Compute Engine)** : [GCP](/install/gcp)
- **exe.dev** (VM + proxy HTTPS) : [exe.dev](/install/exe-dev)
- **AWS (EC2/Lightsail/free tier)** : fonctionne très bien aussi. Guide vidéo :
  https://x.com/techfrenAJ/status/2014934471095812547

## Fonctionnement des configurations cloud

- Le **Gateway (passerelle) s’exécute sur le VPS** et détient l’état + l’espace de travail.
- Vous vous connectez depuis votre ordinateur/téléphone via l’**interface de contrôle** ou **Tailscale/SSH**.
- Traitez le VPS comme la source de vérité et **sauvegardez** l’état + l’espace de travail.
- Sécurité par défaut : conservez le Gateway en local loopback et accédez‑y via un tunnel SSH ou Tailscale Serve.
  Si vous vous liez à `lan`/`tailnet`, exigez `gateway.auth.token` ou `gateway.auth.password`.

Accès à distance : [Gateway remote](/gateway/remote)  
Hub des plateformes : [Platforms](/platforms)

## Utiliser des nodes avec un VPS

Vous pouvez conserver le Gateway dans le cloud et associer des **nodes** sur vos appareils locaux
(Mac/iOS/Android/sans interface). Les nodes fournissent l’écran/la caméra/le canevas locaux et les capacités `system.run`
pendant que le Gateway reste dans le cloud.

Docs : [Nodes](/nodes), [Nodes CLI](/cli/nodes)
