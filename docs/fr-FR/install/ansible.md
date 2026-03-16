---
summary: "Installation OpenClaw automatisée et durcie avec Ansible, VPN Tailscale et isolation pare-feu"
read_when:
  - Vous voulez un déploiement serveur automatisé avec durcissement sécurité
  - Vous avez besoin d'une configuration isolée par pare-feu avec accès VPN
  - Vous déployez sur des serveurs Debian/Ubuntu distants
title: "Ansible"
---

# Installation Ansible

La méthode recommandée pour déployer OpenClaw sur des serveurs de production est via **[openclaw-ansible](https://github.com/openclaw/openclaw-ansible)** — un installateur automatisé avec une architecture axée sur la sécurité.

## Démarrage rapide

Installation en une commande :

```bash
curl -fsSL https://raw.githubusercontent.com/openclaw/openclaw-ansible/main/install.sh | bash
```

> **📦 Guide complet : [github.com/openclaw/openclaw-ansible](https://github.com/openclaw/openclaw-ansible)**
>
> Le dépôt openclaw-ansible est la source de vérité pour le déploiement Ansible. Cette page est un aperçu rapide.

## Ce que vous obtenez

- 🔒 **Sécurité pare-feu d'abord** : UFW + isolation Docker (seulement SSH + Tailscale accessibles)
- 🔐 **VPN Tailscale** : Accès distant sécurisé sans exposer les services publiquement
- 🐳 **Docker** : Conteneurs sandbox isolés, liaisons localhost uniquement
- 🛡️ **Défense en profondeur** : Architecture de sécurité à 4 couches
- 🚀 **Configuration en une commande** : Déploiement complet en minutes
- 🔧 **Intégration systemd** : Démarrage automatique au boot avec durcissement

## Prérequis

- **OS** : Debian 11+ ou Ubuntu 20.04+
- **Accès** : Privilèges root ou sudo
- **Réseau** : Connexion Internet pour installation des packages
- **Ansible** : 2.14+ (installé automatiquement par le script de démarrage rapide)

## Ce qui est installé

Le playbook Ansible installe et configure :

1. **Tailscale** (VPN maillé pour accès distant sécurisé)
2. **Pare-feu UFW** (ports SSH + Tailscale uniquement)
3. **Docker CE + Compose V2** (pour bacs à sable agent)
4. **Node.js 22.x + pnpm** (dépendances d'exécution)
5. **OpenClaw** (basé sur l'hôte, non conteneurisé)
6. **Service systemd** (démarrage automatique avec durcissement sécurité)

Note : La passerelle s'exécute **directement sur l'hôte** (pas dans Docker), mais les bacs à sable agent utilisent Docker pour l'isolation. Voir [sandbox](/fr-FR/gateway/sandboxing) pour les détails.

## Configuration post-installation

Après la fin de l'installation, basculez vers l'utilisateur openclaw :

```bash
sudo -i -u openclaw
```

Le script post-installation vous guidera à travers :

1. **Assistant de configuration initiale** : Configurer les paramètres OpenClaw
2. **Connexion fournisseur** : Connecter WhatsApp/Telegram/Discord/Signal
3. **Test passerelle** : Vérifier l'installation
4. **Configuration Tailscale** : Se connecter à votre maillage VPN

### Commandes rapides

```bash
# Vérifier l'état du service
sudo systemctl status openclaw

# Voir les logs en direct
sudo journalctl -u openclaw -f

# Redémarrer la passerelle
sudo systemctl restart openclaw

# Connexion fournisseur (exécuter en tant qu'utilisateur openclaw)
sudo -i -u openclaw
openclaw channels login
```

## Architecture de sécurité

### Défense à 4 couches

1. **Pare-feu (UFW)** : Seuls SSH (22) + Tailscale (41641/udp) exposés publiquement
2. **VPN (Tailscale)** : Passerelle accessible uniquement via maillage VPN
3. **Isolation Docker** : Chaîne iptables DOCKER-USER empêche l'exposition de port externe
4. **Durcissement systemd** : NoNewPrivileges, PrivateTmp, utilisateur sans privilèges

### Vérification

Tester la surface d'attaque externe :

```bash
nmap -p- VOTRE_IP_SERVEUR
```

Devrait montrer **seulement le port 22** (SSH) ouvert. Tous les autres services (passerelle, Docker) sont verrouillés.

### Disponibilité Docker

Docker est installé pour les **bacs à sable agent** (exécution outil isolée), pas pour exécuter la passerelle elle-même. La passerelle se lie à localhost uniquement et est accessible via VPN Tailscale.

Voir [sandbox et outils multi-agent](/fr-FR/tools/multi-agent-sandbox-tools) pour la configuration du sandbox.

## Installation manuelle

Si vous préférez le contrôle manuel de l'automatisation :

```bash
# 1. Installer les prérequis
sudo apt update && sudo apt install -y ansible git

# 2. Cloner le dépôt
git clone https://github.com/openclaw/openclaw-ansible.git
cd openclaw-ansible

# 3. Installer les collections Ansible
ansible-galaxy collection install -r requirements.yml

# 4. Exécuter le playbook
./run-playbook.sh

# Ou exécuter directement (puis exécuter manuellement /tmp/openclaw-setup.sh après)
# ansible-playbook playbook.yml --ask-become-pass
```

## Mettre à jour OpenClaw

L'installateur Ansible configure OpenClaw pour les mises à jour manuelles. Voir [Mise à jour](/fr-FR/install/updating) pour le flux de mise à jour standard.

Pour relancer le playbook Ansible (par ex. pour des changements de configuration) :

```bash
cd openclaw-ansible
./run-playbook.sh
```

Note : C'est idempotent et sûr à exécuter plusieurs fois.

## Dépannage

### Le pare-feu bloque ma connexion

Si vous êtes bloqué :

- Assurez-vous de pouvoir accéder via VPN Tailscale d'abord
- L'accès SSH (port 22) est toujours autorisé
- La passerelle est **uniquement** accessible via Tailscale par conception

### Le service ne démarre pas

```bash
# Vérifier les logs
sudo journalctl -u openclaw -n 100

# Vérifier les permissions
sudo ls -la /opt/openclaw

# Tester le démarrage manuel
sudo -i -u openclaw
cd ~/openclaw
pnpm start
```

### Problèmes de sandbox Docker

```bash
# Vérifier que Docker tourne
sudo systemctl status docker

# Vérifier l'image sandbox
sudo docker images | grep openclaw-sandbox

# Construire l'image sandbox si manquante
cd /opt/openclaw/openclaw
sudo -u openclaw ./scripts/sandbox-setup.sh
```

### La connexion fournisseur échoue

Assurez-vous d'exécuter en tant qu'utilisateur `openclaw` :

```bash
sudo -i -u openclaw
openclaw channels login
```

## Configuration avancée

Pour l'architecture de sécurité détaillée et le dépannage :

- [Architecture de sécurité](https://github.com/openclaw/openclaw-ansible/blob/main/docs/security.md)
- [Détails techniques](https://github.com/openclaw/openclaw-ansible/blob/main/docs/architecture.md)
- [Guide de dépannage](https://github.com/openclaw/openclaw-ansible/blob/main/docs/troubleshooting.md)

## En relation

- [openclaw-ansible](https://github.com/openclaw/openclaw-ansible) — guide de déploiement complet
- [Docker](/fr-FR/install/docker) — configuration passerelle conteneurisée
- [sandbox](/fr-FR/gateway/sandboxing) — configuration sandbox agent
- [sandbox et outils multi-agent](/fr-FR/tools/multi-agent-sandbox-tools) — isolation par agent
