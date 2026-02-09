---
summary: "Exécuter OpenClaw Gateway 24/7 sur un VPS Hetzner économique (Docker) avec un état durable et des binaires intégrés"
read_when:
  - Vous voulez OpenClaw en fonctionnement 24/7 sur un VPS cloud (pas votre ordinateur portable)
  - Vous voulez une Gateway (passerelle) de niveau production, toujours active, sur votre propre VPS
  - Vous voulez un contrôle total sur la persistance, les binaires et le comportement au redémarrage
  - Vous exécutez OpenClaw dans Docker sur Hetzner ou un fournisseur similaire
title: "Hetzner"
---

# OpenClaw sur Hetzner (Docker, guide VPS de production)

## Objectif

Exécuter une Gateway (passerelle) OpenClaw persistante sur un VPS Hetzner en utilisant Docker, avec un état durable, des binaires intégrés et un comportement de redémarrage sûr.

Si vous voulez « OpenClaw 24/7 pour ~5 $ », c’est la configuration fiable la plus simple.
Les tarifs Hetzner évoluent ; choisissez le plus petit VPS Debian/Ubuntu et montez en gamme si vous rencontrez des OOM.

## Que faisons-nous (en termes simples) ?

- Louer un petit serveur Linux (VPS Hetzner)
- Installer Docker (environnement d’exécution d’applications isolé)
- Démarrer la Gateway (passerelle) OpenClaw dans Docker
- Rendre persistants `~/.openclaw` + `~/.openclaw/workspace` sur l’hôte (survit aux redémarrages/reconstructions)
- Accéder à l’interface de contrôle depuis votre ordinateur portable via un tunnel SSH

La Gateway (passerelle) est accessible via :

- Redirection de port SSH depuis votre ordinateur portable
- Exposition directe de ports si vous gérez vous‑même le pare‑feu et les jetons

Ce guide suppose Ubuntu ou Debian sur Hetzner.  
Si vous utilisez un autre VPS Linux, adaptez les paquets en conséquence.
Pour le flux Docker générique, voir [Docker](/install/docker).

---

## Chemin rapide (opérateurs expérimentés)

1. Approvisionner un VPS Hetzner
2. Installer Docker
3. Cloner le dépôt OpenClaw
4. Créer des répertoires hôte persistants
5. Configurer `.env` et `docker-compose.yml`
6. Intégrer les binaires requis dans l’image
7. `docker compose up -d`
8. Vérifier la persistance et l’accès à la Gateway (passerelle)

---

## Ce dont vous avez besoin

- Un VPS Hetzner avec accès root
- Un accès SSH depuis votre ordinateur portable
- Une aisance de base avec SSH + copier/coller
- ~20 minutes
- Docker et Docker Compose
- Identifiants d’authentification du modèle
- Identifiants de fournisseurs optionnels
  - QR WhatsApp
  - Jeton de bot Telegram
  - OAuth Gmail

---

## 1. Approvisionner le VPS

Créez un VPS Ubuntu ou Debian sur Hetzner.

Connectez‑vous en tant que root :

```bash
ssh root@YOUR_VPS_IP
```

Ce guide suppose que le VPS est à état conservé.
Ne le traitez pas comme une infrastructure jetable.

---

## 2. Installer Docker (sur le VPS)

```bash
apt-get update
apt-get install -y git curl ca-certificates
curl -fsSL https://get.docker.com | sh
```

Vérifier :

```bash
docker --version
docker compose version
```

---

## 3. Cloner le dépôt OpenClaw

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
```

Ce guide suppose que vous allez construire une image personnalisée pour garantir la persistance des binaires.

---

## 4. Créer des répertoires hôte persistants

Les conteneurs Docker sont éphémères.
Tout l’état de longue durée doit résider sur l’hôte.

```bash
mkdir -p /root/.openclaw
mkdir -p /root/.openclaw/workspace

# Set ownership to the container user (uid 1000):
chown -R 1000:1000 /root/.openclaw
chown -R 1000:1000 /root/.openclaw/workspace
```

---

## 5. Configurer les variables d'environnement

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

Générez des secrets robustes :

```bash
openssl rand -hex 32
```

**Ne commitez pas ce fichier.**

---

## 6. Configuration Docker Compose

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
      # Recommended: keep the Gateway loopback-only on the VPS; access via SSH tunnel.
      # To expose it publicly, remove the `127.0.0.1:` prefix and firewall accordingly.
      - "127.0.0.1:${OPENCLAW_GATEWAY_PORT}:18789"

      # Optional: only if you run iOS/Android nodes against this VPS and need Canvas host.
      # If you expose this publicly, read /gateway/security and firewall accordingly.
      # - "18793:18793"
    command:
      [
        "node",
        "dist/index.js",
        "gateway",
        "--bind",
        "${OPENCLAW_GATEWAY_BIND}",
        "--port",
        "${OPENCLAW_GATEWAY_PORT}",
      ]
```

---

## 7. Intégrer les binaires requis dans l’image (critique)

Installer des binaires dans un conteneur en cours d’exécution est un piège.
Tout ce qui est installé à l’exécution sera perdu au redémarrage.

Tous les binaires externes requis par les Skills doivent être installés lors de la construction de l’image.

Les exemples ci‑dessous montrent seulement trois binaires courants :

- `gog` pour l’accès Gmail
- `goplaces` pour Google Places
- `wacli` pour WhatsApp

Ce sont des exemples, pas une liste exhaustive.
Vous pouvez installer autant de binaires que nécessaire en utilisant le même modèle.

Si vous ajoutez ultérieurement de nouvelles Skills qui dépendent de binaires supplémentaires, vous devez :

1. Mettre à jour le Dockerfile
2. Reconstruire l’image
3. Redémarrer les conteneurs

**Exemple de Dockerfile**

```dockerfile
FROM node:22-bookworm

RUN apt-get update && apt-get install -y socat && rm -rf /var/lib/apt/lists/*

# Example binary 1: Gmail CLI
RUN curl -L https://github.com/steipete/gog/releases/latest/download/gog_Linux_x86_64.tar.gz \
  | tar -xz -C /usr/local/bin && chmod +x /usr/local/bin/gog

# Example binary 2: Google Places CLI
RUN curl -L https://github.com/steipete/goplaces/releases/latest/download/goplaces_Linux_x86_64.tar.gz \
  | tar -xz -C /usr/local/bin && chmod +x /usr/local/bin/goplaces

# Example binary 3: WhatsApp CLI
RUN curl -L https://github.com/steipete/wacli/releases/latest/download/wacli_Linux_x86_64.tar.gz \
  | tar -xz -C /usr/local/bin && chmod +x /usr/local/bin/wacli

# Add more binaries below using the same pattern

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

## 8. Construire et lancer

```bash
docker compose build
docker compose up -d openclaw-gateway
```

Vérifier les binaires :

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

## 9. Vérifier la Gateway (passerelle)

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

Ouvrez :

`http://127.0.0.1:18789/`

Collez votre jeton de Gateway (passerelle).

---

## Ce qui persiste où (source de vérité)

OpenClaw s’exécute dans Docker, mais Docker n’est pas la source de vérité.
Tout l’état de longue durée doit survivre aux redémarrages, reconstructions et redémarrages système.

| Composant                            | Emplacement                       | Mécanisme de persistance   | Notes                                               |
| ------------------------------------ | --------------------------------- | -------------------------- | --------------------------------------------------- |
| Configuration Gateway                | `/home/node/.openclaw/`           | Montage de volume hôte     | Inclut `openclaw.json`, jetons                      |
| Profils d’authentification du modèle | `/home/node/.openclaw/`           | Montage de volume hôte     | Jetons OAuth, clés API                              |
| Configurations des Skills            | `/home/node/.openclaw/skills/`    | Montage de volume hôte     | État au niveau des Skills                           |
| Espace de travail de l’agent         | `/home/node/.openclaw/workspace/` | Montage de volume hôte     | Code et artefacts de l’agent                        |
| Session WhatsApp                     | `/home/node/.openclaw/`           | Montage de volume hôte     | Préserve la connexion par QR                        |
| Trousseau Gmail                      | `/home/node/.openclaw/`           | Volume hôte + mot de passe | Nécessite `GOG_KEYRING_PASSWORD`                    |
| Binaires externes                    | `/usr/local/bin/`                 | Image Docker               | Doit être cuit au four au moment de la construction |
| Runtime Node                         | Système de fichiers du conteneur  | Image Docker               | Reconstruit à chaque build d’image                  |
| Paquets OS                           | Système de fichiers du conteneur  | Image Docker               | Ne pas installer à l’exécution                      |
| Conteneur Docker                     | Éphémère                          | Redémarrage                | Sûr à détruire                                      |
