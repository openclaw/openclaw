---
summary: "Installation OpenClaw automatisee et renforcee avec Ansible, VPN Tailscale et isolation par pare-feu"
read_when:
  - Vous souhaitez un deploiement de serveur automatise avec renforcement de la securite
  - Vous avez besoin d'une configuration isolee par pare-feu avec acces VPN
  - Vous deployeez sur des serveurs Debian/Ubuntu distants
title: "Ansible"
---

# Installation Ansible

La methode recommandee pour deployer OpenClaw sur des serveurs de production est via **[openclaw-ansible](https://github.com/openclaw/openclaw-ansible)** — un installateur automatise avec une architecture orientee securite.

## Demarrage rapide

Installation en une commande :

```bash
curl -fsSL https://raw.githubusercontent.com/openclaw/openclaw-ansible/main/install.sh | bash
```

> **📦 Guide complet : [github.com/openclaw/openclaw-ansible](https://github.com/openclaw/openclaw-ansible)**
>
> Le depot openclaw-ansible fait autorite pour le deploiement Ansible. Cette page est un apercu rapide.

## Ce que vous obtenez

- 🔒 **Securite axee pare-feu** : UFW + isolation Docker (seuls SSH + Tailscale sont accessibles)
- 🔐 **VPN Tailscale** : Acces distant securise sans exposition publique des services
- 🐳 **Docker** : Conteneurs sandbox isoles, liaisons uniquement sur localhost
- 🛡️ **Defense en profondeur** : Architecture de securite a 4 couches
- 🚀 **Configuration en une commande** : Deploiement complet en quelques minutes
- 🔧 **Integration systemd** : Demarrage automatique au boot avec durcissement

## Exigences

- **OS** : Debian 11+ ou Ubuntu 20.04+
- **Acces** : Privileges root ou sudo
- **Reseau** : Connexion Internet pour l'installation des paquets
- **Ansible** : 2.14+ (installe automatiquement par le script de demarrage rapide)

## Ce qui est installe

Le playbook Ansible installe et configure :

1. **Tailscale** (VPN maillage pour un acces distant securise)
2. **Pare-feu UFW** (ports SSH + Tailscale uniquement)
3. **Docker CE + Compose V2** (pour les sandboxes d'agents)
4. **Node.js 22.x + pnpm** (dependances d'execution)
5. **OpenClaw** (installe sur l'hote, non conteneurise)
6. **Service systemd** (demarrage automatique avec durcissement de la securite)

Remarque : La Gateway (passerelle) s'execute **directement sur l'hote** (pas dans Docker), mais les sandboxes d'agents utilisent Docker pour l'isolation. Voir [Sandboxing](/gateway/sandboxing) pour plus de details.

## Configuration apres installation

Une fois l'installation terminee, basculez vers l'utilisateur openclaw :

```bash
sudo -i -u openclaw
```

Le script post-installation vous guidera a travers :

1. **Assistant de prise en main** : Configuration des parametres OpenClaw
2. **Connexion aux fournisseurs** : Connecter WhatsApp/Telegram/Discord/Signal
3. **Tests de la Gateway (passerelle)** : Verification de l'installation
4. **Configuration Tailscale** : Connexion a votre maillage VPN

### Commandes rapides

```bash
# Check service status
sudo systemctl status openclaw

# View live logs
sudo journalctl -u openclaw -f

# Restart gateway
sudo systemctl restart openclaw

# Provider login (run as openclaw user)
sudo -i -u openclaw
openclaw channels login
```

## Architecture de securite

### Defense a 4 couches

1. **Pare-feu (UFW)** : Seuls SSH (22) + Tailscale (41641/udp) sont exposes publiquement
2. **VPN (Tailscale)** : La Gateway (passerelle) est accessible uniquement via le maillage VPN
3. **Isolation Docker** : La chaine iptables DOCKER-USER empeche l'exposition de ports externes
4. **Durcissement systemd** : NoNewPrivileges, PrivateTmp, utilisateur non privilegie

### Verification

Tester la surface d'attaque externe :

```bash
nmap -p- YOUR_SERVER_IP
```

Doit afficher **uniquement le port 22** (SSH) ouvert. Tous les autres services (Gateway (passerelle), Docker) sont verrouilles.

### Disponibilite de Docker

Docker est installe pour les **sandboxes d'agents** (execution d'outils isolee), pas pour executer la Gateway (passerelle) elle-meme. La Gateway (passerelle) se lie uniquement a localhost et est accessible via le VPN Tailscale.

Voir [Multi-Agent Sandbox & Tools](/multi-agent-sandbox-tools) pour la configuration des sandboxes.

## Installation manuelle

Si vous preferez un controle manuel plutot que l'automatisation :

```bash
# 1. Install prerequisites
sudo apt update && sudo apt install -y ansible git

# 2. Clone repository
git clone https://github.com/openclaw/openclaw-ansible.git
cd openclaw-ansible

# 3. Install Ansible collections
ansible-galaxy collection install -r requirements.yml

# 4. Run playbook
./run-playbook.sh

# Or run directly (then manually execute /tmp/openclaw-setup.sh after)
# ansible-playbook playbook.yml --ask-become-pass
```

## Mise a jour d'OpenClaw

L'installateur Ansible configure OpenClaw pour des mises a jour manuelles. Voir [Updating](/install/updating) pour le flux de mise a jour standard.

Pour relancer le playbook Ansible (par exemple, pour des changements de configuration) :

```bash
cd openclaw-ansible
./run-playbook.sh
```

Remarque : Ceci est idempotent et peut etre execute en toute securite plusieurs fois.

## Problemes courants

### Le pare-feu bloque ma connexion

Si vous etes bloque :

- Assurez-vous de pouvoir acceder d'abord via le VPN Tailscale
- L'acces SSH (port 22) est toujours autorise
- La Gateway (passerelle) est **uniquement** accessible via Tailscale par conception

### Le service ne demarre pas

```bash
# Check logs
sudo journalctl -u openclaw -n 100

# Verify permissions
sudo ls -la /opt/openclaw

# Test manual start
sudo -i -u openclaw
cd ~/openclaw
pnpm start
```

### Problemes de sandbox Docker

```bash
# Verify Docker is running
sudo systemctl status docker

# Check sandbox image
sudo docker images | grep openclaw-sandbox

# Build sandbox image if missing
cd /opt/openclaw/openclaw
sudo -u openclaw ./scripts/sandbox-setup.sh
```

### Échec de la connexion au fournisseur

Assurez-vous d'executer en tant qu'utilisateur `openclaw` :

```bash
sudo -i -u openclaw
openclaw channels login
```

## Configuration avancee

Pour une architecture de securite detaillee et le depannage :

- [Architecture de securite](https://github.com/openclaw/openclaw-ansible/blob/main/docs/security.md)
- [Details techniques](https://github.com/openclaw/openclaw-ansible/blob/main/docs/architecture.md)
- [Guide de depannage](https://github.com/openclaw/openclaw-ansible/blob/main/docs/troubleshooting.md)

## Associe

- [openclaw-ansible](https://github.com/openclaw/openclaw-ansible) — guide de deploiement complet
- [Docker](/install/docker) — configuration de la Gateway (passerelle) conteneurisee
- [Sandboxing](/gateway/sandboxing) — configuration des sandboxes d'agents
- [Multi-Agent Sandbox & Tools](/multi-agent-sandbox-tools) — isolation par agent
