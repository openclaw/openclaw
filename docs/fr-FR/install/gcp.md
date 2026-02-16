---
summary: "Exécuter la passerelle OpenClaw 24/7 sur une VM GCP Compute Engine (Docker) avec état durable"
read_when:
  - Vous voulez OpenClaw fonctionnant 24/7 sur GCP
  - Vous voulez une passerelle toujours active de qualité production sur votre propre VM
  - Vous voulez un contrôle total sur la persistance, les binaires et le comportement de redémarrage
title: "GCP"
---

# OpenClaw sur GCP Compute Engine (Docker, Guide VPS de production)

## Objectif

Exécuter une passerelle OpenClaw persistante sur une VM GCP Compute Engine utilisant Docker, avec état durable, binaires intégrés et comportement de redémarrage sécurisé.

Si vous voulez "OpenClaw 24/7 pour ~5-12 $/mois", c'est une configuration fiable sur Google Cloud.
Les tarifs varient selon le type de machine et la région ; choisissez la plus petite VM adaptée à votre charge de travail et augmentez si vous rencontrez des OOMs.

## Que faisons-nous (en termes simples) ?

- Créer un projet GCP et activer la facturation
- Créer une VM Compute Engine
- Installer Docker (environnement d'exécution d'application isolée)
- Démarrer la passerelle OpenClaw dans Docker
- Persister `~/.openclaw` + `~/.openclaw/workspace` sur l'hôte (survit aux redémarrages/reconstructions)
- Accéder à l'interface de contrôle depuis votre ordinateur portable via un tunnel SSH

La passerelle est accessible via :

- Transfert de port SSH depuis votre ordinateur portable
- Exposition de port directe si vous gérez vous-même le pare-feu et les tokens

Ce guide utilise Debian sur GCP Compute Engine.
Ubuntu fonctionne aussi ; adaptez les paquets en conséquence.
Pour le flux Docker générique, voir [Docker](/fr-FR/install/docker).

---

## Chemin rapide (opérateurs expérimentés)

1. Créer le projet GCP + activer l'API Compute Engine
2. Créer une VM Compute Engine (e2-small, Debian 12, 20 Go)
3. Se connecter en SSH à la VM
4. Installer Docker
5. Cloner le dépôt OpenClaw
6. Créer les répertoires hôtes persistants
7. Configurer `.env` et `docker-compose.yml`
8. Intégrer les binaires requis, construire et lancer

---

## Ce dont vous avez besoin

- Compte GCP (éligible niveau gratuit pour e2-micro)
- CLI gcloud installée (ou utiliser Cloud Console)
- Accès SSH depuis votre ordinateur portable
- Confort de base avec SSH + copier/coller
- ~20-30 minutes
- Docker et Docker Compose
- Identifiants d'authentification modèle
- Identifiants de fournisseur optionnels
  - QR WhatsApp
  - Token de bot Telegram
  - OAuth Gmail

---

## 1) Installer la CLI gcloud (ou utiliser la Console)

**Option A : CLI gcloud** (recommandé pour l'automatisation)

Installer depuis [https://cloud.google.com/sdk/docs/install](https://cloud.google.com/sdk/docs/install)

Initialiser et s'authentifier :

```bash
gcloud init
gcloud auth login
```

**Option B : Console Cloud**

Toutes les étapes peuvent être effectuées via l'interface web à [https://console.cloud.google.com](https://console.cloud.google.com)

---

## 2) Créer un projet GCP

**CLI :**

```bash
gcloud projects create my-openclaw-project --name="OpenClaw Gateway"
gcloud config set project my-openclaw-project
```

Activer la facturation sur [https://console.cloud.google.com/billing](https://console.cloud.google.com/billing) (requis pour Compute Engine).

Activer l'API Compute Engine :

```bash
gcloud services enable compute.googleapis.com
```

**Console :**

1. Aller à IAM & Admin > Créer un projet
2. Le nommer et créer
3. Activer la facturation pour le projet
4. Naviguer vers APIs & Services > Activer les API > rechercher "Compute Engine API" > Activer

---

## 3) Créer la VM

**Types de machines :**

| Type     | Specs                      | Coût                    | Notes                               |
| -------- | -------------------------- | ----------------------- | ----------------------------------- |
| e2-small | 2 vCPU, 2 Go RAM           | ~12 $/mois              | Recommandé                          |
| e2-micro | 2 vCPU (partagé), 1 Go RAM | Éligible niveau gratuit | Peut manquer de mémoire sous charge |

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

1. Aller à Compute Engine > Instances VM > Créer une instance
2. Nom : `openclaw-gateway`
3. Région : `us-central1`, Zone : `us-central1-a`
4. Type de machine : `e2-small`
5. Disque de démarrage : Debian 12, 20 Go
6. Créer

---

## 4) Se connecter en SSH à la VM

**CLI :**

```bash
gcloud compute ssh openclaw-gateway --zone=us-central1-a
```

**Console :**

Cliquez sur le bouton "SSH" à côté de votre VM dans le tableau de bord Compute Engine.

Note : La propagation de la clé SSH peut prendre 1-2 minutes après la création de la VM. Si la connexion est refusée, attendez et réessayez.

---

## 5) Installer Docker (sur la VM)

```bash
sudo apt-get update
sudo apt-get install -y git curl ca-certificates
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
```

Déconnectez-vous et reconnectez-vous pour que le changement de groupe prenne effet :

```bash
exit
```

Puis reconnectez-vous en SSH :

```bash
gcloud compute ssh openclaw-gateway --zone=us-central1-a
```

Vérifiez :

```bash
docker --version
docker compose version
```

---

## 6) Cloner le dépôt OpenClaw

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
```

Ce guide suppose que vous allez construire une image personnalisée pour garantir la persistance des binaires.

---

## 7) Créer les répertoires hôtes persistants

Les conteneurs Docker sont éphémères.
Tout l'état à long terme doit vivre sur l'hôte.

```bash
mkdir -p ~/.openclaw
mkdir -p ~/.openclaw/workspace
```

---

## 8) Configurer les variables d'environnement

Créez `.env` à la racine du dépôt.

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

Générez des secrets forts :

```bash
openssl rand -hex 32
```

**Ne committez pas ce fichier.**

---

## 9) Configuration Docker Compose

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
      # Recommandé : garder la passerelle en loopback uniquement sur la VM ; accéder via tunnel SSH.
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
      ]
```

---

## 10) Intégrer les binaires requis dans l'image (critique)

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

## 11) Construire et lancer

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

## 12) Vérifier la passerelle

```bash
docker compose logs -f openclaw-gateway
```

Succès :

```
[gateway] listening on ws://0.0.0.0:18789
```

---

## 13) Accéder depuis votre ordinateur portable

Créez un tunnel SSH pour transférer le port de la passerelle :

```bash
gcloud compute ssh openclaw-gateway --zone=us-central1-a -- -L 18789:127.0.0.1:18789
```

Ouvrez dans votre navigateur :

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

## Mises à jour

Pour mettre à jour OpenClaw sur la VM :

```bash
cd ~/openclaw
git pull
docker compose build
docker compose up -d
```

---

## Dépannage

**Connexion SSH refusée**

La propagation de la clé SSH peut prendre 1-2 minutes après la création de la VM. Attendez et réessayez.

**Problèmes OS Login**

Vérifiez votre profil OS Login :

```bash
gcloud compute os-login describe-profile
```

Assurez-vous que votre compte a les permissions IAM requises (Compute OS Login ou Compute OS Admin Login).

**Manque de mémoire (OOM)**

Si vous utilisez e2-micro et rencontrez des OOM, passez à e2-small ou e2-medium :

```bash
# Arrêtez d'abord la VM
gcloud compute instances stop openclaw-gateway --zone=us-central1-a

# Changez le type de machine
gcloud compute instances set-machine-type openclaw-gateway \
  --zone=us-central1-a \
  --machine-type=e2-small

# Démarrez la VM
gcloud compute instances start openclaw-gateway --zone=us-central1-a
```

---

## Comptes de service (bonne pratique de sécurité)

Pour un usage personnel, votre compte utilisateur par défaut fonctionne bien.

Pour l'automatisation ou les pipelines CI/CD, créez un compte de service dédié avec des permissions minimales :

1. Créez un compte de service :

   ```bash
   gcloud iam service-accounts create openclaw-deploy \
     --display-name="OpenClaw Deployment"
   ```

2. Accordez le rôle Compute Instance Admin (ou un rôle personnalisé plus restreint) :

   ```bash
   gcloud projects add-iam-policy-binding my-openclaw-project \
     --member="serviceAccount:openclaw-deploy@my-openclaw-project.iam.gserviceaccount.com" \
     --role="roles/compute.instanceAdmin.v1"
   ```

Évitez d'utiliser le rôle Propriétaire pour l'automatisation. Utilisez le principe du moindre privilège.

Voir [https://cloud.google.com/iam/docs/understanding-roles](https://cloud.google.com/iam/docs/understanding-roles) pour les détails des rôles IAM.

---

## Prochaines étapes

- Configurer les canaux de messagerie : [Canaux](/fr-FR/channels)
- Appairer des appareils locaux comme nœuds : [Nœuds](/fr-FR/nodes)
- Configurer la passerelle : [Configuration de la passerelle](/fr-FR/gateway/configuration)
