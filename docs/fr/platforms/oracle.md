---
summary: "OpenClaw sur Oracle Cloud (ARM Always Free)"
read_when:
  - Configuration d’OpenClaw sur Oracle Cloud
  - Recherche d’un hébergement VPS à faible coût pour OpenClaw
  - Besoin d’OpenClaw 24/7 sur un petit serveur
title: "Oracle Cloud"
---

# OpenClaw sur Oracle Cloud (OCI)

## Objectif

Exécuter un Gateway (passerelle) OpenClaw persistant sur l’offre ARM **Always Free** d’Oracle Cloud.

L’offre gratuite d’Oracle peut être très adaptée à OpenClaw (en particulier si vous disposez déjà d’un compte OCI), mais elle comporte des compromis :

- Architecture ARM (la plupart des éléments fonctionnent, mais certains binaires peuvent être uniquement x86)
- Capacité et inscription parfois capricieuses

## Comparaison des coûts (2026)

| Fournisseur  | Forfait         | Specifications            | Prix/mo              | Notes                                 |
| ------------ | --------------- | ------------------------- | -------------------- | ------------------------------------- |
| Oracle Cloud | Always Free ARM | jusqu’à 4 OCPU, 24 Go RAM | $0                   | ARM, capacité limitée                 |
| Hetzner      | CX22            | 2 vCPU, 4 Go RAM          | ~ $4 | Option payante la moins chère         |
| DigitalOcean | Basic           | 1 vCPU, 1 Go RAM          | $6                   | Interface simple, bonne documentation |
| Vultr        | Cloud Compute   | 1 vCPU, 1 Go RAM          | $6                   | Nombreux emplacements                 |
| Linode       | Nanode          | 1 vCPU, 1 Go RAM          | $5                   | Désormais partie d’Akamai             |

---

## Prérequis

- Compte Oracle Cloud ([inscription](https://www.oracle.com/cloud/free/)) — voir le [guide communautaire d’inscription](https://gist.github.com/rssnyder/51e3cfedd730e7dd5f4a816143b25dbd) en cas de problème
- Compte Tailscale (gratuit sur [tailscale.com](https://tailscale.com))
- ~30 minutes

## 1. Créer une instance OCI

1. Connectez-vous à la [console Oracle Cloud](https://cloud.oracle.com/)
2. Accédez à **Compute → Instances → Create Instance**
3. Configurez :
   - **Name :** `openclaw`
   - **Image :** Ubuntu 24.04 (aarch64)
   - **Shape :** `VM.Standard.A1.Flex` (Ampere ARM)
   - **OCPUs :** 2 (ou jusqu’à 4)
   - **Memory :** 12 Go (ou jusqu’à 24 Go)
   - **Boot volume :** 50 Go (jusqu’à 200 Go gratuits)
   - **SSH key :** Ajoutez votre clé publique
4. Cliquez sur **Create**
5. Notez l’adresse IP publique

**Astuce :** si la création de l’instance échoue avec « Out of capacity », essayez un autre domaine de disponibilité ou réessayez plus tard. La capacité du free tier est limitée.

## 2. Se connecter et mettre à jour

```bash
# Connect via public IP
ssh ubuntu@YOUR_PUBLIC_IP

# Update system
sudo apt update && sudo apt upgrade -y
sudo apt install -y build-essential
```

**Note :** `build-essential` est requis pour la compilation ARM de certaines dépendances.

## 3. Configurer l’utilisateur et le nom d’hôte

```bash
# Set hostname
sudo hostnamectl set-hostname openclaw

# Set password for ubuntu user
sudo passwd ubuntu

# Enable lingering (keeps user services running after logout)
sudo loginctl enable-linger ubuntu
```

## 4. Installer Tailscale

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --ssh --hostname=openclaw
```

Cela active Tailscale SSH, afin que vous puissiez vous connecter via `ssh openclaw` depuis n’importe quel appareil de votre tailnet — sans IP publique nécessaire.

Vérifiez :

```bash
tailscale status
```

**À partir de maintenant, connectez-vous via Tailscale :** `ssh ubuntu@openclaw` (ou utilisez l’IP Tailscale).

## 5. Installer OpenClaw

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
source ~/.bashrc
```

Lorsque la question « How do you want to hatch your bot? » s’affiche, sélectionnez **« Do this later »**.

> Note : en cas de problèmes de build natif ARM, commencez par les paquets système (par exemple `sudo apt install -y build-essential`) avant d’envisager Homebrew.

## 6. Configurer le Gateway (passerelle) (loopback + authentification par token) et activer Tailscale Serve

Utilisez l’authentification par token comme valeur par défaut. Elle est prévisible et évite d’avoir besoin d’indicateurs « insecure auth » dans l’interface Control.

```bash
# Keep the Gateway private on the VM
openclaw config set gateway.bind loopback

# Require auth for the Gateway + Control UI
openclaw config set gateway.auth.mode token
openclaw doctor --generate-gateway-token

# Expose over Tailscale Serve (HTTPS + tailnet access)
openclaw config set gateway.tailscale.mode serve
openclaw config set gateway.trustedProxies '["127.0.0.1"]'

systemctl --user restart openclaw-gateway
```

## 7. Vérifier

```bash
# Check version
openclaw --version

# Check daemon status
systemctl --user status openclaw-gateway

# Check Tailscale Serve
tailscale serve status

# Test local response
curl http://localhost:18789
```

## 8. Verrouiller la sécurité du VCN

Maintenant que tout fonctionne, verrouillez le VCN afin de bloquer tout le trafic sauf Tailscale. Le Virtual Cloud Network d’OCI agit comme un pare-feu en périphérie du réseau — le trafic est bloqué avant d’atteindre votre instance.

1. Allez dans **Networking → Virtual Cloud Networks** dans la console OCI
2. Cliquez sur votre VCN → **Security Lists** → Default Security List
3. **Supprimez** toutes les règles d’entrée sauf :
   - `0.0.0.0/0 UDP 41641` (Tailscale)
4. Conservez les règles de sortie par défaut (autoriser tout le trafic sortant)

Cela bloque SSH sur le port 22, HTTP, HTTPS et tout le reste en périphérie du réseau. Désormais, vous ne pouvez vous connecter que via Tailscale.

---

## Accéder à l’interface Control

Depuis n’importe quel appareil de votre réseau Tailscale :

```
https://openclaw.<tailnet-name>.ts.net/
```

Remplacez `<tailnet-name>` par le nom de votre tailnet (visible dans `tailscale status`).

Aucun tunnel SSH requis. Tailscale fournit :

- Chiffrement HTTPS (certificats automatiques)
- Authentification via l’identité Tailscale
- Accès depuis n’importe quel appareil de votre tailnet (ordinateur portable, téléphone, etc.)

---

## Sécurité : VCN + Tailscale (référence recommandée)

Avec le VCN verrouillé (seul l’UDP 41641 est ouvert) et le Gateway (passerelle) lié au loopback, vous bénéficiez d’une défense en profondeur solide : le trafic public est bloqué à la périphérie du réseau et l’accès administrateur se fait via votre tailnet.

Cette configuration supprime souvent le _besoin_ de règles de pare-feu locales supplémentaires uniquement pour bloquer les attaques SSH par force brute à l’échelle d’Internet — mais vous devez tout de même maintenir l’OS à jour, exécuter `openclaw security audit`, et vérifier que vous n’écoutez pas par erreur sur des interfaces publiques.

### Ce qui est déjà protégé

| Étape traditionnelle   | Nécessaire ?     | Pourquoi                                                                                        |
| ---------------------- | ---------------- | ----------------------------------------------------------------------------------------------- |
| Pare-feu UFW           | Non              | Le VCN bloque avant que le trafic n’atteigne l’instance                                         |
| fail2ban               | Non              | Pas de force brute si le port 22 est bloqué au niveau du VCN                                    |
| Renforcement de sshd   | Non              | Tailscale SSH n’utilise pas sshd                                                                |
| Désactiver root login  | Non              | Tailscale utilise l’identité Tailscale, pas les utilisateurs système                            |
| Auth SSH par clé seule | Non              | Tailscale authentifie via votre tailnet                                                         |
| Renforcement IPv6      | Généralement non | Dépend des paramètres de votre VCN/sous-réseau ; vérifiez ce qui est réellement attribué/exposé |

### Toujours recommandé

- **Permissions des identifiants :** `chmod 700 ~/.openclaw`
- **Audit de sécurité :** `openclaw security audit`
- **Mises à jour système :** exécutez `sudo apt update && sudo apt upgrade` régulièrement
- **Surveiller Tailscale :** examinez les appareils dans la [console d’administration Tailscale](https://login.tailscale.com/admin)

### Vérifier la posture de sécurité

```bash
# Confirm no public ports listening
sudo ss -tlnp | grep -v '127.0.0.1\|::1'

# Verify Tailscale SSH is active
tailscale status | grep -q 'offers: ssh' && echo "Tailscale SSH active"

# Optional: disable sshd entirely
sudo systemctl disable --now ssh
```

---

## Solution de repli : tunnel SSH

Si Tailscale Serve ne fonctionne pas, utilisez un tunnel SSH :

```bash
# From your local machine (via Tailscale)
ssh -L 18789:127.0.0.1:18789 ubuntu@openclaw
```

Puis ouvrez `http://localhost:18789`.

---

## Problemes courants

### La création de l’instance échoue (« Out of capacity »)

Les instances ARM du free tier sont populaires. Essayez :

- Un autre domaine de disponibilité
- Une nouvelle tentative en heures creuses (tôt le matin)
- Le filtre « Always Free » lors de la sélection de la forme

### Tailscale ne se connecte pas

```bash
# Check status
sudo tailscale status

# Re-authenticate
sudo tailscale up --ssh --hostname=openclaw --reset
```

### Le Gateway (passerelle) ne démarre pas

```bash
openclaw gateway status
openclaw doctor --non-interactive
journalctl --user -u openclaw-gateway -n 50
```

### Impossible d’atteindre l’interface Control

```bash
# Verify Tailscale Serve is running
tailscale serve status

# Check gateway is listening
curl http://localhost:18789

# Restart if needed
systemctl --user restart openclaw-gateway
```

### Problèmes de binaires ARM

Certains outils peuvent ne pas disposer de builds ARM. Vérifiez :

```bash
uname -m  # Should show aarch64
```

La plupart des packages npm fonctionnent correctement. Pour les binaires, recherchez des versions `linux-arm64` ou `aarch64`.

---

## Persistance

Tout l’état se trouve dans :

- `~/.openclaw/` — configuration, identifiants, données de session
- `~/.openclaw/workspace/` — espace de travail (SOUL.md, mémoire, artefacts)

Sauvegardez périodiquement :

```bash
tar -czvf openclaw-backup.tar.gz ~/.openclaw ~/.openclaw/workspace
```

---

## Voir aussi

- [Accès distant au Gateway (passerelle)](/gateway/remote) — autres modèles d’accès distant
- [Intégration Tailscale](/gateway/tailscale) — documentation Tailscale complète
- [Configuration du Gateway (passerelle)](/gateway/configuration) — toutes les options de configuration
- [Guide DigitalOcean](/platforms/digitalocean) — si vous souhaitez une option payante avec inscription plus simple
- [Guide Hetzner](/install/hetzner) — alternative basée sur Docker
