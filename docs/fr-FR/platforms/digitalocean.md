---
summary: "OpenClaw sur DigitalOcean (option VPS payante simple)"
read_when:
  - Configuration OpenClaw sur DigitalOcean
  - Recherche hébergement VPS pas cher pour OpenClaw
title: "DigitalOcean"
---

# OpenClaw sur DigitalOcean

## Objectif

Exécuter une Passerelle OpenClaw persistante sur DigitalOcean pour **$6/mois** (ou $4/mois avec tarif réservé).

Si vous voulez une option $0/mois et ne craignez pas ARM + setup spécifique fournisseur, voir le [guide Oracle Cloud](/fr-FR/platforms/oracle).

## Comparaison coûts (2026)

| Fournisseur  | Plan            | Specs                    | Prix/mois   | Notes                                 |
| ------------ | --------------- | ------------------------ | ----------- | ------------------------------------- |
| Oracle Cloud | Always Free ARM | jusqu'à 4 OCPU, 24GB RAM | $0          | ARM, capacité limitée / quirks signup |
| Hetzner      | CX22            | 2 vCPU, 4GB RAM          | €3.79 (~$4) | Option payante la moins chère         |
| DigitalOcean | Basic           | 1 vCPU, 1GB RAM          | $6          | UX facile, bons docs                  |
| Vultr        | Cloud Compute   | 1 vCPU, 1GB RAM          | $6          | Nombreux emplacements                 |
| Linode       | Nanode          | 1 vCPU, 1GB RAM          | $5          | Maintenant partie d'Akamai            |

**Choisir un fournisseur :**

- DigitalOcean : UX la plus simple + setup prévisible (ce guide)
- Hetzner : bon prix/perf (voir [guide Hetzner](/fr-FR/install/hetzner))
- Oracle Cloud : peut être $0/mois, mais plus capricieux et ARM uniquement (voir [guide Oracle](/fr-FR/platforms/oracle))

## Prérequis

- Compte DigitalOcean ([inscription avec crédit gratuit $200](https://m.do.co/c/signup))
- Paire clés SSH (ou volonté utiliser auth par mot de passe)
- ~20 minutes

## 1) Créer un Droplet

1. Connexion à [DigitalOcean](https://cloud.digitalocean.com/)
2. Cliquez **Create → Droplets**
3. Choisissez :
   - **Région :** Plus proche de vous (ou vos utilisateurs)
   - **Image :** Ubuntu 24.04 LTS
   - **Taille :** Basic → Regular → **$6/mo** (1 vCPU, 1GB RAM, 25GB SSD)
   - **Authentification :** Clé SSH (recommandé) ou mot de passe
4. Cliquez **Create Droplet**
5. Notez l'adresse IP

## 2) Connecter via SSH

```bash
ssh root@YOUR_DROPLET_IP
```

## 3) Installer OpenClaw

```bash
# Mettre à jour système
apt update && apt upgrade -y

# Installer Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs

# Installer OpenClaw
curl -fsSL https://openclaw.ai/install.sh | bash

# Vérifier
openclaw --version
```

## 4) Exécuter Onboarding

```bash
openclaw onboard --install-daemon
```

L'assistant vous guidera à travers :

- Auth modèle (clés API ou OAuth)
- Setup canal (Telegram, WhatsApp, Discord, etc.)
- Jeton passerelle (auto-généré)
- Installation daemon (systemd)

## 5) Vérifier la Passerelle

```bash
# Vérifier status
openclaw status

# Vérifier service
systemctl --user status openclaw-gateway.service

# Voir logs
journalctl --user -u openclaw-gateway.service -f
```

## 6) Accéder au Dashboard

La passerelle se lie à loopback par défaut. Pour accéder au Control UI :

**Option A : Tunnel SSH (recommandé)**

```bash
# Depuis votre machine locale
ssh -L 18789:localhost:18789 root@YOUR_DROPLET_IP

# Puis ouvrez : http://localhost:18789
```

**Option B : Tailscale Serve (HTTPS, loopback uniquement)**

```bash
# Sur le droplet
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up

# Configurer Passerelle pour utiliser Tailscale Serve
openclaw config set gateway.tailscale.mode serve
openclaw gateway restart
```

Ouvrez : `https://<magicdns>/`

Notes :

- Serve garde la Passerelle loopback uniquement et authentifie via headers identité Tailscale.
- Pour nécessiter jeton/mot de passe à la place, définissez `gateway.auth.allowTailscale: false` ou utilisez `gateway.auth.mode: "password"`.

Voir aussi : [Tailscale](/fr-FR/gateway/tailscale), [Accès distant](/fr-FR/gateway/remote)
