---
summary: "Exécuter la passerelle OpenClaw 24/7 sur un VPS Hetzner bon marché (Docker) avec état durable et binaires intégrés"
read_when:
  - Vous voulez OpenClaw fonctionnant 24/7 sur un VPS cloud (pas sur votre ordinateur portable)
  - Vous voulez une passerelle toujours active de qualité production sur votre propre VPS
  - Vous voulez un contrôle total sur la persistance, les binaires et le comportement de redémarrage
  - Vous exécutez OpenClaw dans Docker sur Hetzner ou un fournisseur similaire
title: "Hetzner"
---

# OpenClaw sur Hetzner (Docker, Guide VPS de production)

## Objectif

Exécuter une passerelle OpenClaw persistante sur un VPS Hetzner utilisant Docker, avec état durable, binaires intégrés et comportement de redémarrage sécurisé.

Si vous voulez "OpenClaw 24/7 pour ~5 $", c'est la configuration fiable la plus simple.
Les tarifs Hetzner changent ; choisissez le plus petit VPS Debian/Ubuntu et augmentez si vous rencontrez des OOMs.

## Que faisons-nous (en termes simples) ?

- Louer un petit serveur Linux (VPS Hetzner)
- Installer Docker (environnement d'exécution d'application isolée)
- Démarrer la passerelle OpenClaw dans Docker
- Persister `~/.openclaw` + `~/.openclaw/workspace` sur l'hôte (survit aux redémarrages/reconstructions)
- Accéder à l'interface de contrôle depuis votre ordinateur portable via un tunnel SSH

La passerelle est accessible via :

- Transfert de port SSH depuis votre ordinateur portable
- Exposition de port directe si vous gérez vous-même le pare-feu et les tokens

Ce guide suppose Ubuntu ou Debian sur Hetzner.  
Si vous êtes sur un autre VPS Linux, adaptez les paquets en conséquence.
Pour le flux Docker générique, voir [Docker](/fr-FR/install/docker).

---

## Chemin rapide (opérateurs expérimentés)

1. Provisionner un VPS Hetzner
2. Installer Docker
3. Cloner le dépôt OpenClaw
4. Créer les répertoires hôtes persistants
5. Configurer `.env` et `docker-compose.yml`
6. Intégrer les binaires requis dans l'image
7. `docker compose up -d`
8. Vérifier la persistance et l'accès à la passerelle

---

## Ce dont vous avez besoin

- VPS Hetzner avec accès root
- Accès SSH depuis votre ordinateur portable
- Confort de base avec SSH + copier/coller
- ~20 minutes
- Docker et Docker Compose
- Identifiants d'authentification modèle
- Identifiants de fournisseur optionnels
  - QR WhatsApp
  - Token de bot Telegram
  - OAuth Gmail

---

## 1) Provisionner le VPS

Créez un VPS Ubuntu ou Debian chez Hetzner.

Connectez-vous en tant que root :

```bash
ssh root@YOUR_VPS_IP
```

Ce guide suppose que le VPS est avec état.
Ne le traitez pas comme une infrastructure jetable.

---

## 2) Installer Docker (sur le VPS)

```bash
apt-get update
apt-get install -y git curl ca-certificates
curl -fsSL https://get.docker.com | sh
```

Vérifiez :

```bash
docker --version
docker compose version
```

---

## 3) Cloner le dépôt OpenClaw

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
```

Ce guide suppose que vous allez construire une image personnalisée pour garantir la persistance des binaires.

---

## 4) Créer les répertoires hôtes persistants

Les conteneurs Docker sont éphémères.
Tout l'état à long terme doit vivre sur l'hôte.

```bash
mkdir -p /root/.openclaw/workspace

# Définir la propriété à l'utilisateur du conteneur (uid 1000) :
chown -R 1000:1000 /root/.openclaw
```

---

## 5) Configurer les variables d'environnement

Créez `.env` à la racine du dépôt.

```bash
OPENCLAW_IMAGE=openclaw:latest
OPENCLAW_GATEWAY_TOKEN=change-me-now
OPENCLAW_GATEWAY_BIND=lan
OPENCLAW_GATEWAY_PORT=18789

OPENCLAW_CONFIG_DIR=/root/.openclaw
OPENCLAW_WORKSPACE_DIR=/root/.openclaw/workspace

GOG_KEYRING_PASSWORD=change-me-now
XDG_CONFIG_HOME=/home/node/.openclaw
```

Générez des secrets forts :

```bash
openssl rand -hex 32
```

**Ne committez pas ce fichier.**

---

## 6) Configuration Docker Compose

Créez ou mettez à jour `docker-compose.yml`.

```yaml
services:
  openclaw-gateway:
    image: ${OPENCLAW_IMAGE}
    build: .
    restart: unless-stopped
    env_file:
      - .env
    environment:
      - HOME=/home/node
      - NODE_ENV=production
      - TERM=xterm-256color
      - OPENCLAW_GATEWAY_BIND=${OPENCLAW_GATEWAY_BIND}
      - OPENCLAW_GATEWAY_PORT=${OPENCLAW_GATEWAY_PORT}
      - OPENCLAW_GATEWAY_TOKEN=${OPENCLAW_GATEWAY_TOKEN}
      - GOG_KEYRING_PASSWORD=${GOG_KEYRING_PASSWORD}
      - XDG_CONFIG_HOME=${XDG_CONFIG_HOME}
      - PATH=/home/linuxbrew/.linuxbrew/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
    volumes:
      - ${OPENCLAW_CONFIG_DIR}:/home/node/.openclaw
      - ${OPENCLAW_WORKSPACE_DIR}:/home/node/.openclaw/workspace
    ports:
      # Recommandé : garder la passerelle en loopback uniquement sur le VPS ; accéder via tunnel SSH.
      # Pour l'exposer publiquement, retirez le préfixe `127.0.0.1:` et configurez le pare-feu en conséquence.
      - "127.0.0.1:${OPENCLAW_GATEWAY_PORT}:18789"
    command:
      [
        "node",
        "dist/index.js",
        "gateway",
        "--bind",
        "${OPENCLAW_GATEWAY_BIND}",
        "--port",
        "${OPENCLAW_GATEWAY_PORT}",
        "--allow-unconfigured",
      ]
```

`--allow-unconfigured` est uniquement pour la commodité du démarrage initial, ce n'est pas un remplacement pour une configuration appropriée de la passerelle. Définissez toujours l'authentification (`gateway.auth.token` ou mot de passe) et utilisez des paramètres de liaison sûrs pour votre déploiement.

---

## 7) Intégrer les binaires requis dans l'image (critique)

Installer des binaires dans un conteneur en cours d'exécution est un piège.
Tout ce qui est installé au moment de l'exécution sera perdu au redémarrage.

Tous les binaires externes requis par les compétences doivent être installés au moment de la construction de l'image.

Les exemples ci-dessous ne montrent que trois binaires courants :

- `gog` pour l'accès Gmail
- `goplaces` pour Google Places
- `wacli` pour WhatsApp

Ce sont des exemples, pas une liste complète.
Vous pouvez installer autant de binaires que nécessaire en utilisant le même modèle.

Si vous ajoutez de nouvelles compétences plus tard qui dépendent de binaires supplémentaires, vous devez :

1. Mettre à jour le Dockerfile
2. Reconstruire l'image
3. Redémarrer les conteneurs

**Exemple de Dockerfile**

```dockerfile
FROM node:22-bookworm

RUN apt-get update && apt-get install -y socat && rm -rf /var/lib/apt/lists/*

# Exemple binaire 1 : CLI Gmail
RUN curl -L https://github.com/steipete/gog/releases/latest/download/gog_Linux_x86_64.tar.gz \
  | tar -xz -C /usr/local/bin && chmod +x /usr/local/bin/gog

# Exemple binaire 2 : CLI Google Places
RUN curl -L https://github.com/steipete/goplaces/releases/latest/download/goplaces_Linux_x86_64.tar.gz \
  | tar -xz -C /usr/local/bin && chmod +x /usr/local/bin/goplaces

# Exemple binaire 3 : CLI WhatsApp
RUN curl -L https://github.com/steipete/wacli/releases/latest/download/wacli_Linux_x86_64.tar.gz \
  | tar -xz -C /usr/local/bin && chmod +x /usr/local/bin/wacli

# Ajoutez plus de binaires ci-dessous en utilisant le même modèle

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY ui/package.json ./ui/package.json
COPY scripts ./scripts

RUN corepack enable
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build
RUN pnpm ui:install
RUN pnpm ui:build

ENV NODE_ENV=production

CMD ["node","dist/index.js"]
```

---

## 8) Construire et lancer

```bash
docker compose build
docker compose up -d openclaw-gateway
```

Vérifiez les binaires :

```bash
docker compose exec openclaw-gateway which gog
docker compose exec openclaw-gateway which goplaces
docker compose exec openclaw-gateway which wacli
```

Sortie attendue :

```
/usr/local/bin/gog
/usr/local/bin/goplaces
/usr/local/bin/wacli
```

---

## 9) Vérifier la passerelle

```bash
docker compose logs -f openclaw-gateway
```

Succès :

```
[gateway] listening on ws://0.0.0.0:18789
```

Depuis votre ordinateur portable :

```bash
ssh -N -L 18789:127.0.0.1:18789 root@YOUR_VPS_IP
```

Ouvrir :

`http://127.0.0.1:18789/`

Collez votre token de passerelle.

---

## Ce qui persiste où (source de vérité)

OpenClaw s'exécute dans Docker, mais Docker n'est pas la source de vérité.
Tout l'état à long terme doit survivre aux redémarrages, reconstructions et réinitialisations.

| Composant                      | Emplacement                       | Mécanisme de persistance              | Notes                                          |
| ------------------------------ | --------------------------------- | ------------------------------------- | ---------------------------------------------- |
| Configuration passerelle       | `/home/node/.openclaw/`           | Montage de volume hôte                | Inclut `openclaw.json`, tokens                 |
| Profils auth modèle            | `/home/node/.openclaw/`           | Montage de volume hôte                | Tokens OAuth, clés API                         |
| Configurations compétences     | `/home/node/.openclaw/skills/`    | Montage de volume hôte                | État niveau compétence                         |
| Espace de travail agent        | `/home/node/.openclaw/workspace/` | Montage de volume hôte                | Code et artefacts agent                        |
| Session WhatsApp               | `/home/node/.openclaw/`           | Montage de volume hôte                | Préserve la connexion QR                       |
| Trousseau Gmail                | `/home/node/.openclaw/`           | Montage de volume hôte + mot de passe | Nécessite `GOG_KEYRING_PASSWORD`               |
| Binaires externes              | `/usr/local/bin/`                 | Image Docker                          | Doit être intégré au moment de la construction |
| Environnement d'exécution Node | Système de fichiers conteneur     | Image Docker                          | Reconstruit à chaque construction d'image      |
| Paquets OS                     | Système de fichiers conteneur     | Image Docker                          | Ne pas installer au moment de l'exécution      |
| Conteneur Docker               | Éphémère                          | Redémarrable                          | Sûr de détruire                                |

---

## Infrastructure as Code (Terraform)

Pour les équipes préférant les workflows d'infrastructure-as-code, une configuration Terraform maintenue par la communauté fournit :

- Configuration Terraform modulaire avec gestion d'état distant
- Provisionnement automatisé via cloud-init
- Scripts de déploiement (bootstrap, deploy, backup/restore)
- Renforcement de la sécurité (pare-feu, UFW, accès SSH uniquement)
- Configuration de tunnel SSH pour l'accès à la passerelle

**Dépôts :**

- Infrastructure : [openclaw-terraform-hetzner](https://github.com/andreesg/openclaw-terraform-hetzner)
- Configuration Docker : [openclaw-docker-config](https://github.com/andreesg/openclaw-docker-config)

Cette approche complète la configuration Docker ci-dessus avec des déploiements reproductibles, une infrastructure versionnée et une récupération après sinistre automatisée.

> **Note :** Maintenu par la communauté. Pour les problèmes ou contributions, voir les liens de dépôt ci-dessus.
