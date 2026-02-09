---
summary: "OpenClaw sur DigitalOcean (option VPS payante simple)"
read_when:
  - Mise en place d’OpenClaw sur DigitalOcean
  - Recherche d’un hébergement VPS bon marché pour OpenClaw
title: "DigitalOcean"
---

# OpenClaw sur DigitalOcean

## Objectif

Exécuter une Gateway OpenClaw persistante sur DigitalOcean pour **6 $/mois** (ou 4 $/mois avec la tarification réservée).

Si vous souhaitez une option à 0 $/mois et que l’ARM + une configuration spécifique au fournisseur ne vous dérangent pas, consultez le [guide Oracle Cloud](/platforms/oracle).

## Comparaison des coûts (2026)

| Fournisseur  | Forfait         | Specs                     | Prix/mo                                          | Notes                                             |
| ------------ | --------------- | ------------------------- | ------------------------------------------------ | ------------------------------------------------- |
| Oracle Cloud | Always Free ARM | jusqu’à 4 OCPU, 24 Go RAM | 0 $                                              | ARM, capacité limitée / contraintes d’inscription |
| Hetzner      | CX22            | 2 vCPU, 4 Go RAM          | 3,79 € (~4 $) | Option payante la moins chère                     |
| DigitalOcean | Basic           | 1 vCPU, 1 Go RAM          | 6 $                                              | Interface simple, bonne documentation             |
| Vultr        | Cloud Compute   | 1 vCPU, 1 Go RAM          | 6 $                                              | Nombreux emplacements                             |
| Linode       | Nanode          | 1 vCPU, 1 Go RAM          | 5 $                                              | Désormais intégré à Akamai                        |

**Choisir un fournisseur :**

- DigitalOcean : UX la plus simple + configuration prévisible (ce guide)
- Hetzner : bon rapport prix/perf (voir le [guide Hetzner](/install/hetzner))
- Oracle Cloud : peut être à 0 $/mois, mais plus capricieux et uniquement ARM (voir le [guide Oracle](/platforms/oracle))

---

## Prérequis

- Compte DigitalOcean ([inscription avec 200 $ de crédit gratuit](https://m.do.co/c/signup))
- Paire de clés SSH (ou acceptation d’utiliser l’authentification par mot de passe)
- ~20 minutes

## 1. Créer un Droplet

1. Connectez-vous à [DigitalOcean](https://cloud.digitalocean.com/)
2. Cliquez sur **Create → Droplets**
3. Choisissez :
   - **Region :** la plus proche de vous (ou de vos utilisateurs)
   - **Image :** Ubuntu 24.04 LTS
   - **Size :** Basic → Regular → **6 $/mois** (1 vCPU, 1 Go RAM, 25 Go SSD)
   - **Authentication :** clé SSH (recommandé) ou mot de passe
4. Cliquez sur **Create Droplet**
5. Notez l’adresse IP

## 2) Connexion via SSH

```bash
ssh root@YOUR_DROPLET_IP
```

## 3. Installer OpenClaw

```bash
# Update system
apt update && apt upgrade -y

# Install Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs

# Install OpenClaw
curl -fsSL https://openclaw.ai/install.sh | bash

# Verify
openclaw --version
```

## 4. Lancer la prise en main

```bash
openclaw onboard --install-daemon
```

L’assistant vous guidera à travers :

- Authentification du modèle (clés API ou OAuth)
- Configuration des canaux (Telegram, WhatsApp, Discord, etc.)
- Jeton de la Gateway (généré automatiquement)
- Installation du daemon (systemd)

## 5. Vérifier la Gateway

```bash
# Check status
openclaw status

# Check service
systemctl --user status openclaw-gateway.service

# View logs
journalctl --user -u openclaw-gateway.service -f
```

## 6. Accéder au tableau de bord

La gateway se lie au loopback par défaut. Pour accéder à l’interface de contrôle :

**Option A : tunnel SSH (recommandé)**

```bash
# From your local machine
ssh -L 18789:localhost:18789 root@YOUR_DROPLET_IP

# Then open: http://localhost:18789
```

**Option B : Tailscale Serve (HTTPS, loopback uniquement)**

```bash
# On the droplet
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up

# Configure Gateway to use Tailscale Serve
openclaw config set gateway.tailscale.mode serve
openclaw gateway restart
```

Ouvrez : `https://<magicdns>/`

Notes :

- Serve maintient la Gateway en loopback et authentifie via les en-têtes d’identité Tailscale.
- Pour exiger un jeton/mot de passe à la place, définissez `gateway.auth.allowTailscale: false` ou utilisez `gateway.auth.mode: "password"`.

**Option C : liaison Tailnet (sans Serve)**

```bash
openclaw config set gateway.bind tailnet
openclaw gateway restart
```

Ouvrez : `http://<tailscale-ip>:18789` (jeton requis).

## 7. Connecter vos canaux

### Telegram

```bash
openclaw pairing list telegram
openclaw pairing approve telegram <CODE>
```

### WhatsApp

```bash
openclaw channels login whatsapp
# Scan QR code
```

Voir [Canaux](/channels) pour les autres fournisseurs.

---

## Optimisations pour 1 Go de RAM

Le droplet à 6 $ ne dispose que de 1 Go de RAM. Pour que tout fonctionne correctement :

### Ajouter du swap (recommandé)

```bash
fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

### Utiliser un modèle plus léger

Si vous rencontrez des OOM, envisagez :

- D’utiliser des modèles via API (Claude, GPT) plutôt que des modèles locaux
- De définir `agents.defaults.model.primary` sur un modèle plus petit

### Surveiller la mémoire

```bash
free -h
htop
```

---

## Persistance

Tout l’état est stocké dans :

- `~/.openclaw/` — configuration, identifiants, données de session
- `~/.openclaw/workspace/` — espace de travail (SOUL.md, mémoire, etc.)

Ils survivent aux redémarrages. Sauvegardez-les périodiquement :

```bash
tar -czvf openclaw-backup.tar.gz ~/.openclaw ~/.openclaw/workspace
```

---

## Alternative gratuite Oracle Cloud

Oracle Cloud propose des instances ARM **Always Free** nettement plus puissantes que toutes les options payantes ici — pour 0 $/mois.

| Ce que vous obtenez    | Specs                        |
| ---------------------- | ---------------------------- |
| **4 OCPU**             | ARM Ampere A1                |
| **24 Go RAM**          | Plus que suffisant           |
| **200 Go de stockage** | Volume bloc                  |
| **Gratuit à vie**      | Aucune facturation par carte |

**Limitations :**

- L’inscription peut être capricieuse (réessayez en cas d’échec)
- Architecture ARM — la plupart des choses fonctionnent, mais certains binaires nécessitent des versions ARM

Pour le guide de configuration complet, voir [Oracle Cloud](/platforms/oracle). Pour des conseils d’inscription et le dépannage du processus d’enrôlement, consultez ce [guide communautaire](https://gist.github.com/rssnyder/51e3cfedd730e7dd5f4a816143b25dbd).

---

## Problemes courants

### La Gateway ne démarre pas

```bash
openclaw gateway status
openclaw doctor --non-interactive
journalctl -u openclaw --no-pager -n 50
```

### Port déjà utilisé

```bash
lsof -i :18789
kill <PID>
```

### Manque de mémoire

```bash
# Check memory
free -h

# Add more swap
# Or upgrade to $12/mo droplet (2GB RAM)
```

---

## Voir aussi

- [Guide Hetzner](/install/hetzner) — moins cher, plus puissant
- [Installation Docker](/install/docker) — configuration conteneurisée
- [Tailscale](/gateway/tailscale) — accès distant sécurisé
- [Configuration](/gateway/configuration) — référence complète de configuration
