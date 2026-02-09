---
summary: "Exécutez OpenClaw Gateway 24/7 sur une VM GCP Compute Engine (Docker) avec un état persistant"
read_when:
  - Vous souhaitez qu’OpenClaw fonctionne 24/7 sur GCP
  - Vous voulez une Gateway (passerelle) toujours active, de niveau production, sur votre propre VM
  - Vous voulez un contrôle total sur la persistance, les binaires et le comportement au redémarrage
title: "GCP"
---

# OpenClaw sur GCP Compute Engine (Docker, guide VPS de production)

## Objectif

Exécuter une Gateway (passerelle) OpenClaw persistante sur une VM GCP Compute Engine en utilisant Docker, avec un état durable, des binaires intégrés à l’image et un comportement de redémarrage sûr.

Si vous voulez « OpenClaw 24/7 pour ~5–12 $/mois », c’est une configuration fiable sur Google Cloud.
Les tarifs varient selon le type de machine et la région ; choisissez la plus petite VM adaptée à votre charge de travail et montez en gamme si vous rencontrez des OOM.

## Que faisons-nous (en termes simples) ?

- Créer un projet GCP et activer la facturation
- Créer une VM Compute Engine
- Installer Docker (runtime applicatif isolé)
- Démarrer la Gateway (passerelle) OpenClaw dans Docker
- Rendre persistants `~/.openclaw` + `~/.openclaw/workspace` sur l’hôte (survivent aux redémarrages/reconstructions)
- Accéder à l’interface de contrôle depuis votre ordinateur via un tunnel SSH

La Gateway peut être accessible via :

- Le transfert de port SSH depuis votre ordinateur
- L’exposition directe du port si vous gérez vous‑même le pare-feu et les jetons

Ce guide utilise Debian sur GCP Compute Engine.
Ubuntu fonctionne également ; adaptez les paquets en conséquence.
Pour le flux Docker générique, voir [Docker](/install/docker).

---

## Chemin rapide (opérateurs expérimentés)

1. Créer un projet GCP + activer l’API Compute Engine
2. Créer une VM Compute Engine (e2-small, Debian 12, 20 Go)
3. Se connecter en SSH à la VM
4. Installer Docker
5. Cloner le dépôt OpenClaw
6. Créer des répertoires persistants sur l’hôte
7. Configurer `.env` et `docker-compose.yml`
8. Intégrer les binaires requis, construire et lancer

---

## Ce dont vous avez besoin

- Compte GCP (éligible au free tier pour e2-micro)
- CLI gcloud installée (ou utilisation de la Cloud Console)
- Accès SSH depuis votre ordinateur
- Aisance de base avec SSH + copier/coller
- ~20–30 minutes
- Docker et Docker Compose
- Identifiants d’authentification de modèle
- Identifiants de fournisseur optionnels
  - QR WhatsApp
  - Jeton de bot Telegram
  - OAuth Gmail

---

## 1. Installer la CLI gcloud (ou utiliser la Console)

**Option A : CLI gcloud** (recommandé pour l’automatisation)

Installer depuis https://cloud.google.com/sdk/docs/install

Initialiser et s’authentifier :

```bash
gcloud init
gcloud auth login
```

**Option B : Cloud Console**

Toutes les étapes peuvent être effectuées via l’interface web sur https://console.cloud.google.com

---

## 2. Créer un projet GCP

**CLI :**

```bash
gcloud projects create my-openclaw-project --name="OpenClaw Gateway"
gcloud config set project my-openclaw-project
```

Activer la facturation sur https://console.cloud.google.com/billing (requis pour Compute Engine).

Activer l’API Compute Engine :

```bash
gcloud services enable compute.googleapis.com
```

**Console :**

1. Aller dans IAM et administration > Créer un projet
2. Le nommer et le créer
3. Activer la facturation pour le projet
4. Aller dans API et services > Activer des API > rechercher « Compute Engine API » > Activer

---

## 3. Créer la VM

**Types de machines :**

| Type     | Spécifications                                 | Coût                       | Notes                |
| -------- | ---------------------------------------------- | -------------------------- | -------------------- |
| e2-small | 2 vCPU, 2 Go RAM                               | ~12 $/mois | Recommandé           |
| e2-micro | 2 vCPU (partagés), 1 Go RAM | Éligible free tier         | Peut OOM sous charge |

**CLI :**

```bash
gcloud compute instances create openclaw-gateway \
  --zone=us-central1-a \
  --machine-type=e2-small \
  --boot-disk-size=20GB \
  --image-family=debian-12 \
  --image-project=debian-cloud
```

**Console :**

1. Aller dans Compute Engine > Instances de VM > Créer une instance
2. Nom : `openclaw-gateway`
3. Région : `us-central1`, Zone : `us-central1-a`
4. Type de machine : `e2-small`
5. Disque de démarrage : Debian 12, 20 Go
6. Créer

---

## 4. Se connecter en SSH à la VM

**CLI :**

```bash
gcloud compute ssh openclaw-gateway --zone=us-central1-a
```

**Console :**

Cliquer sur le bouton « SSH » à côté de votre VM dans le tableau de bord Compute Engine.

Remarque : la propagation des clés SSH peut prendre 1 à 2 minutes après la création de la VM. Si la connexion est refusée, attendez puis réessayez.

---

## 5. Installer Docker (sur la VM)

```bash
sudo apt-get update
sudo apt-get install -y git curl ca-certificates
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
```

Se déconnecter puis se reconnecter pour que le changement de groupe prenne effet :

```bash
exit
```

Puis se reconnecter en SSH :

```bash
gcloud compute ssh openclaw-gateway --zone=us-central1-a
```

Vérifier :

```bash
docker --version
docker compose version
```

---

## 6. Cloner le dépôt OpenClaw

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
```

Ce guide suppose que vous allez construire une image personnalisée afin de garantir la persistance des binaires.

---

## 7. Créer des répertoires persistants sur l’hôte

Les conteneurs Docker sont éphémères.
Tout l’état de longue durée doit résider sur l’hôte.

```bash
mkdir -p ~/.openclaw
mkdir -p ~/.openclaw/workspace
```

---

## 8. Configurer les variables d’environnement

Créer `.env` à la racine du dépôt.

```bash
OPENCLAW_IMAGE=openclaw:latest
OPENCLAW_GATEWAY_TOKEN=change-me-now
OPENCLAW_GATEWAY_BIND=lan
OPENCLAW_GATEWAY_PORT=18789

OPENCLAW_CONFIG_DIR=/home/$USER/.openclaw
OPENCLAW_WORKSPACE_DIR=/home/$USER/.openclaw/workspace

GOG_KEYRING_PASSWORD=change-me-now
XDG_CONFIG_HOME=/home/node/.openclaw
```

Générer des secrets forts :

```bash
openssl rand -hex 32
```

**Ne commettez pas ce fichier.**

---

## 9. Configuration Docker Compose

Créer ou mettre à jour `docker-compose.yml`.

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
      # Recommended: keep the Gateway loopback-only on the VM; access via SSH tunnel.
      # To expose it publicly, remove the `127.0.0.1:` prefix and firewall accordingly.
      - "127.0.0.1:${OPENCLAW_GATEWAY_PORT}:18789"

      # Optional: only if you run iOS/Android nodes against this VM and need Canvas host.
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

## 10. Intégrer les binaires requis dans l’image (critique)

Installer des binaires dans un conteneur en cours d’exécution est un piège.
Tout ce qui est installé à l’exécution sera perdu au redémarrage.

Tous les binaires externes requis par les Skills doivent être installés lors de la construction de l’image.

Les exemples ci-dessous montrent seulement trois binaires courants :

- `gog` pour l’accès Gmail
- `goplaces` pour Google Places
- `wacli` pour WhatsApp

Ce sont des exemples, pas une liste exhaustive.
Vous pouvez installer autant de binaires que nécessaire en utilisant le même schéma.

Si vous ajoutez plus tard de nouveaux Skills dépendant de binaires supplémentaires, vous devez :

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

## 11. Construire et lancer

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

## 12. Vérifier la Gateway (passerelle)

```bash
docker compose logs -f openclaw-gateway
```

Succès :

```
[gateway] listening on ws://0.0.0.0:18789
```

---

## 13. Accéder depuis votre ordinateur

Créer un tunnel SSH pour rediriger le port de la Gateway :

```bash
gcloud compute ssh openclaw-gateway --zone=us-central1-a -- -L 18789:127.0.0.1:18789
```

Ouvrir dans votre navigateur :

`http://127.0.0.1:18789/`

Collez votre jeton de Gateway.

---

## Où persiste quoi (source de vérité)

OpenClaw s’exécute dans Docker, mais Docker n’est pas la source de vérité.
Tout l’état de longue durée doit survivre aux redémarrages, reconstructions et redémarrages système.

| Composant                    | Emplacement                       | Mécanisme de persistance   | Notes                                               |
| ---------------------------- | --------------------------------- | -------------------------- | --------------------------------------------------- |
| Configuration Gateway        | `/home/node/.openclaw/`           | Montage de volume hôte     | Inclut `openclaw.json`, jetons                      |
| Profils d’auth modèle        | `/home/node/.openclaw/`           | Montage de volume hôte     | Jetons OAuth, clés API                              |
| Configurations des Skills    | `/home/node/.openclaw/skills/`    | Montage de volume hôte     | État au niveau des Skills                           |
| Espace de travail de l’agent | `/home/node/.openclaw/workspace/` | Montage de volume hôte     | Code et artefacts de l’agent                        |
| Session WhatsApp             | `/home/node/.openclaw/`           | Montage de volume hôte     | Conserve la connexion QR                            |
| Trousseau Gmail              | `/home/node/.openclaw/`           | Volume hôte + mot de passe | Requiert `GOG_KEYRING_PASSWORD`                     |
| Binaires externes            | `/usr/local/bin/`                 | Image Docker               | Doit être cuit au four au moment de la construction |
| Runtime Node                 | Système de fichiers du conteneur  | Image Docker               | Reconstruit à chaque build d’image                  |
| Paquets OS                   | Système de fichiers du conteneur  | Image Docker               | Ne pas installer à l’exécution                      |
| Conteneur Docker             | Éphémère                          | Redémarrage                | Sûr à détruire                                      |

---

## Mises à jour

Pour mettre à jour OpenClaw sur la VM :

```bash
cd ~/openclaw
git pull
docker compose build
docker compose up -d
```

---

## Problemes courants

**Connexion SSH refusée**

La propagation des clés SSH peut prendre 1 à 2 minutes après la création de la VM. Attendez puis réessayez.

**Problèmes OS Login**

Vérifiez votre profil OS Login :

```bash
gcloud compute os-login describe-profile
```

Assurez-vous que votre compte dispose des autorisations IAM requises (Compute OS Login ou Compute OS Admin Login).

**Mémoire insuffisante (OOM)**

Si vous utilisez e2-micro et rencontrez des OOM, passez à e2-small ou e2-medium :

```bash
# Stop the VM first
gcloud compute instances stop openclaw-gateway --zone=us-central1-a

# Change machine type
gcloud compute instances set-machine-type openclaw-gateway \
  --zone=us-central1-a \
  --machine-type=e2-small

# Start the VM
gcloud compute instances start openclaw-gateway --zone=us-central1-a
```

---

## Comptes de service (bonne pratique de sécurité)

Pour un usage personnel, votre compte utilisateur par défaut suffit.

Pour l’automatisation ou les pipelines CI/CD, créez un compte de service dédié avec des autorisations minimales :

1. Créer un compte de service :

   ```bash
   gcloud iam service-accounts create openclaw-deploy \
     --display-name="OpenClaw Deployment"
   ```

2. Accorder le rôle Compute Instance Admin (ou un rôle personnalisé plus restreint) :

   ```bash
   gcloud projects add-iam-policy-binding my-openclaw-project \
     --member="serviceAccount:openclaw-deploy@my-openclaw-project.iam.gserviceaccount.com" \
     --role="roles/compute.instanceAdmin.v1"
   ```

Évitez d’utiliser le rôle Owner pour l’automatisation. Appliquez le principe du moindre privilège.

Voir https://cloud.google.com/iam/docs/understanding-roles pour les détails sur les rôles IAM.

---

## Prochaines étapes

- Configurer les canaux de messagerie : [Channels](/channels)
- Associer des appareils locaux comme nœuds : [Nodes](/nodes)
- Configurer la Gateway (passerelle) : [Gateway configuration](/gateway/configuration)
