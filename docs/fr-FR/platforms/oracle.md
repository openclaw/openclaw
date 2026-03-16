---
summary: "OpenClaw sur Oracle Cloud (ARM Always Free)"
read_when:
  - Configuration OpenClaw sur Oracle Cloud
  - Recherche hébergement VPS low-cost pour OpenClaw
  - Voulez OpenClaw 24/7 sur petit serveur
title: "Oracle Cloud"
---

# OpenClaw sur Oracle Cloud (OCI)

## Objectif

Exécuter Passerelle OpenClaw persistante sur tier ARM **Always Free** Oracle Cloud.

Le tier gratuit Oracle peut être excellent fit pour OpenClaw (surtout si vous avez déjà compte OCI), mais vient avec compromis :

- Architecture ARM (la plupart des choses fonctionnent, mais certains binaires peuvent être x86-only)
- Capacité et signup peuvent être capricieux

## Comparaison Coût (2026)

| Provider     | Plan            | Specs                    | Prix/mois | Notes                       |
| ------------ | --------------- | ------------------------ | --------- | --------------------------- |
| Oracle Cloud | Always Free ARM | jusqu'à 4 OCPU, 24GB RAM | $0        | ARM, capacité limitée       |
| Hetzner      | CX22            | 2 vCPU, 4GB RAM          | ~ $4      | Option payée la moins chère |
| DigitalOcean | Basic           | 1 vCPU, 1GB RAM          | $6        | UI facile, bonnes docs      |
| Vultr        | Cloud Compute   | 1 vCPU, 1GB RAM          | $6        | Nombreux emplacements       |
| Linode       | Nanode          | 1 vCPU, 1GB RAM          | $5        | Maintenant partie Akamai    |

## Prérequis

- Compte Oracle Cloud ([signup](https://www.oracle.com/cloud/free/))
- Compte Tailscale (gratuit sur [tailscale.com](https://tailscale.com))
- ~30 minutes

## 1) Créer Instance OCI

1. Connectez-vous à [Oracle Cloud Console](https://cloud.oracle.com/)
2. Naviguez vers **Compute → Instances → Create Instance**
3. Configurez :
   - **Name:** `openclaw`
   - **Image:** Ubuntu 24.04 (aarch64)
   - **Shape:** `VM.Standard.A1.Flex` (Ampere ARM)
   - **OCPUs:** 2 (ou jusqu'à 4)
   - **Memory:** 12 GB (ou jusqu'à 24 GB)
   - **Boot volume:** 50 GB (jusqu'à 200 GB gratuit)
   - **SSH key:** Ajoutez votre clé publique
4. Cliquez **Create**
5. Notez adresse IP publique

**Astuce :** Si création instance échoue avec "Out of capacity", essayez domaine availability différent ou réessayez plus tard. Capacité tier gratuit est limitée.

## 2) Connecter et Mettre à jour

```bash
# Connectez via IP publique
ssh ubuntu@VOTRE_IP_PUBLIQUE

# Mettez à jour système
sudo apt update && sudo apt upgrade -y
```

## 3) Installer OpenClaw

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

Suivez l'assistant onboarding.

## 4) Configurer Tailscale (optionnel mais recommandé)

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

Voir aussi :

- [VPS](/vps)
- [DigitalOcean](/fr-FR/platforms/digitalocean)
- [Installation](/fr-FR/install/index)
