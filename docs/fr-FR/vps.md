---
summary: "Hub d'hébergement VPS pour OpenClaw (Oracle/Fly/Hetzner/GCP/exe.dev)"
read_when:
  - Vous voulez exécuter la Passerelle dans le cloud
  - Vous avez besoin d'une carte rapide des guides VPS/hébergement
title: "Hébergement VPS"
---

# Hébergement VPS

Ce hub lie les guides VPS/hébergement supportés et explique comment les déploiements cloud fonctionnent à un niveau élevé.

## Choisir un fournisseur

- **Railway** (un clic + configuration navigateur) : [Railway](/fr-FR/install/railway)
- **Northflank** (un clic + configuration navigateur) : [Northflank](/fr-FR/install/northflank)
- **Oracle Cloud (Always Free)** : [Oracle](/fr-FR/platforms/oracle) — $0/mois (Always Free, ARM ; capacité/inscription peut être capricieuse)
- **Fly.io** : [Fly.io](/fr-FR/install/fly)
- **Hetzner (Docker)** : [Hetzner](/fr-FR/install/hetzner)
- **GCP (Compute Engine)** : [GCP](/fr-FR/install/gcp)
- **exe.dev** (VM + proxy HTTPS) : [exe.dev](/fr-FR/install/exe-dev)
- **AWS (EC2/Lightsail/niveau gratuit)** : fonctionne bien aussi. Guide vidéo :
  [https://x.com/techfrenAJ/status/2014934471095812547](https://x.com/techfrenAJ/status/2014934471095812547)

## Comment fonctionnent les configurations cloud

- La **Passerelle s'exécute sur le VPS** et possède l'état + l'espace de travail.
- Vous vous connectez depuis votre ordinateur portable/téléphone via l'**UI de Contrôle** ou **Tailscale/SSH**.
- Traitez le VPS comme la source de vérité et **sauvegardez** l'état + l'espace de travail.
- Valeur par défaut sécurisée : gardez la Passerelle sur loopback et accédez-y via tunnel SSH ou Tailscale Serve.
  Si vous liez à `lan`/`tailnet`, exigez `gateway.auth.token` ou `gateway.auth.password`.

Accès distant : [Gateway remote](/fr-FR/gateway/remote)  
Hub Plateformes : [Plateformes](/fr-FR/platforms)

## Utiliser des nœuds avec un VPS

Vous pouvez garder la Passerelle dans le cloud et appairer des **nœuds** sur vos appareils locaux (Mac/iOS/Android/headless). Les nœuds fournissent des capacités écran/caméra/canvas locales et `system.run` tandis que la Passerelle reste dans le cloud.

Docs : [Nœuds](/fr-FR/nodes), [CLI Nœuds](/fr-FR/cli/nodes)
