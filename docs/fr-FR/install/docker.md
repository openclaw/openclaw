---
summary: "Configuration Docker optionnelle et configuration initiale pour OpenClaw"
read_when:
  - Vous voulez une passerelle conteneurisée au lieu d'installations locales
  - Vous validez le flux Docker
title: "Docker"
---

# Docker (optionnel)

Docker est **optionnel**. Utilisez-le uniquement si vous voulez une passerelle conteneurisée ou pour valider le flux Docker.

## Docker me convient-il ?

- **Oui** : vous voulez un environnement de passerelle isolé et jetable ou exécuter OpenClaw sur un hôte sans installations locales.
- **Non** : vous exécutez sur votre propre machine et voulez juste la boucle de développement la plus rapide. Utilisez le flux d'installation normal à la place.
- **Note sur l'isolation en sandbox** : l'isolation en sandbox d'agent utilise aussi Docker, mais elle ne nécessite **pas** que la passerelle complète s'exécute dans Docker. Voir [Isolation en sandbox](/fr-FR/gateway/sandboxing).

Ce guide couvre :

- Passerelle conteneurisée (OpenClaw complet dans Docker)
- sandbox d'agent par session (passerelle hôte + outils agent isolés dans Docker)

Détails sur l'isolation en sandbox : [Isolation en sandbox](/fr-FR/gateway/sandboxing)

## Prérequis

- Docker Desktop (ou Docker Engine) + Docker Compose v2
- Espace disque suffisant pour les images + journaux

## Passerelle conteneurisée (Docker Compose)

### Démarrage rapide (recommandé)

Depuis la racine du dépôt :

```bash
./docker-setup.sh
```

Ce script :

- construit l'image de la passerelle
- exécute l'assistant de configuration initiale
- affiche des conseils de configuration de fournisseur optionnels
- démarre la passerelle via Docker Compose
- génère un token de passerelle et l'écrit dans `.env`

Variables d'environnement optionnelles :

- `OPENCLAW_DOCKER_APT_PACKAGES` — installer des paquets apt supplémentaires pendant la construction
- `OPENCLAW_EXTRA_MOUNTS` — ajouter des montages de liaison hôte supplémentaires
- `OPENCLAW_HOME_VOLUME` — persister `/home/node` dans un volume nommé

Après la fin :

- Ouvrez `http://127.0.0.1:18789/` dans votre navigateur.
- Collez le token dans l'interface de contrôle (Paramètres → token).
- Besoin de l'URL à nouveau ? Exécutez `docker compose run --rm openclaw-cli dashboard --no-open`.

Il écrit la configuration/espace de travail sur l'hôte :

- `~/.openclaw/`
- `~/.openclaw/workspace`

Exécution sur un VPS ? Voir [Hetzner (VPS Docker)](/fr-FR/install/hetzner).

### Aides Shell (optionnel)

Pour faciliter la gestion Docker au quotidien, installez `ClawDock` :

```bash
mkdir -p ~/.clawdock && curl -sL https://raw.githubusercontent.com/openclaw/openclaw/main/scripts/shell-helpers/clawdock-helpers.sh -o ~/.clawdock/clawdock-helpers.sh
```

**Ajouter à votre configuration shell (zsh) :**

```bash
echo 'source ~/.clawdock/clawdock-helpers.sh' >> ~/.zshrc && source ~/.zshrc
```

Puis utilisez `clawdock-start`, `clawdock-stop`, `clawdock-dashboard`, etc. Exécutez `clawdock-help` pour toutes les commandes.

Voir [README des aides `ClawDock`](https://github.com/openclaw/openclaw/blob/main/scripts/shell-helpers/README.md) pour les détails.

### Flux manuel (compose)

```bash
docker build -t openclaw:local -f Dockerfile .
docker compose run --rm openclaw-cli onboard
docker compose up -d openclaw-gateway
```

Note : exécutez `docker compose ...` depuis la racine du dépôt. Si vous avez activé
`OPENCLAW_EXTRA_MOUNTS` ou `OPENCLAW_HOME_VOLUME`, le script de configuration écrit
`docker-compose.extra.yml` ; incluez-le lors de l'exécution de Compose ailleurs :

```bash
docker compose -f docker-compose.yml -f docker-compose.extra.yml <command>
```

### Token d'interface de contrôle + appairage (Docker)

Si vous voyez "non autorisé" ou "déconnecté (1008) : appairage requis", récupérez un
lien de tableau de bord frais et approuvez l'appareil navigateur :

```bash
docker compose run --rm openclaw-cli dashboard --no-open
docker compose run --rm openclaw-cli devices list
docker compose run --rm openclaw-cli devices approve <requestId>
```

Plus de détails : [Tableau de bord](/fr-FR/web/dashboard), [Appareils](/fr-FR/cli/devices).

### Montages supplémentaires (optionnel)

Si vous voulez monter des répertoires hôtes supplémentaires dans les conteneurs, définissez
`OPENCLAW_EXTRA_MOUNTS` avant d'exécuter `docker-setup.sh`. Cela accepte une
liste séparée par des virgules de montages de liaison Docker et les applique à la fois à
`openclaw-gateway` et `openclaw-cli` en générant `docker-compose.extra.yml`.

Exemple :

```bash
export OPENCLAW_EXTRA_MOUNTS="$HOME/.codex:/home/node/.codex:ro,$HOME/github:/home/node/github:rw"
./docker-setup.sh
```

Notes :

- Les chemins doivent être partagés avec Docker Desktop sur macOS/Windows.
- Si vous modifiez `OPENCLAW_EXTRA_MOUNTS`, réexécutez `docker-setup.sh` pour régénérer le
  fichier compose supplémentaire.
- `docker-compose.extra.yml` est généré. Ne le modifiez pas manuellement.

### Persister tout le répertoire home du conteneur (optionnel)

Si vous voulez que `/home/node` persiste à travers les recréations de conteneur, définissez un
volume nommé via `OPENCLAW_HOME_VOLUME`. Cela crée un volume Docker et le monte à
`/home/node`, tout en conservant les montages de liaison configuration/espace de travail standard. Utilisez un
volume nommé ici (pas un chemin de liaison) ; pour les montages de liaison, utilisez
`OPENCLAW_EXTRA_MOUNTS`.

Exemple :

```bash
export OPENCLAW_HOME_VOLUME="openclaw_home"
./docker-setup.sh
```

Vous pouvez combiner cela avec des montages supplémentaires :

```bash
export OPENCLAW_HOME_VOLUME="openclaw_home"
export OPENCLAW_EXTRA_MOUNTS="$HOME/.codex:/home/node/.codex:ro,$HOME/github:/home/node/github:rw"
./docker-setup.sh
```

Notes :

- Si vous changez `OPENCLAW_HOME_VOLUME`, réexécutez `docker-setup.sh` pour régénérer le
  fichier compose supplémentaire.
- Le volume nommé persiste jusqu'à suppression avec `docker volume rm <name>`.

### Installer des paquets apt supplémentaires (optionnel)

Si vous avez besoin de paquets système dans l'image (par exemple, outils de construction ou
bibliothèques média), définissez `OPENCLAW_DOCKER_APT_PACKAGES` avant d'exécuter `docker-setup.sh`.
Cela installe les paquets pendant la construction de l'image, donc ils persistent même si le
conteneur est supprimé.

Exemple :

```bash
export OPENCLAW_DOCKER_APT_PACKAGES="ffmpeg build-essential"
./docker-setup.sh
```

Notes :

- Cela accepte une liste séparée par des espaces de noms de paquets apt.
- Si vous changez `OPENCLAW_DOCKER_APT_PACKAGES`, réexécutez `docker-setup.sh` pour reconstruire
  l'image.

### Conteneur utilisateur avancé / complet (opt-in)

L'image Docker par défaut est **axée sur la sécurité** et s'exécute en tant qu'utilisateur `node` non-root. Cela garde la surface d'attaque petite, mais cela signifie :

- pas d'installations de paquets système au moment de l'exécution
- pas de Homebrew par défaut
- pas de navigateurs Chromium/Playwright intégrés

Si vous voulez un conteneur plus complet, utilisez ces options opt-in :

1. **Persister `/home/node`** pour que les téléchargements de navigateur et caches d'outils survivent :

```bash
export OPENCLAW_HOME_VOLUME="openclaw_home"
./docker-setup.sh
```

2. **Intégrer des dépendances système dans l'image** (répétable + persistant) :

```bash
export OPENCLAW_DOCKER_APT_PACKAGES="git curl jq"
./docker-setup.sh
```

3. **Installer les navigateurs Playwright sans `npx`** (évite les conflits d'écrasement npm) :

```bash
docker compose run --rm openclaw-cli \
  node /app/node_modules/playwright-core/cli.js install chromium
```

Si vous avez besoin que Playwright installe des dépendances système, reconstruisez l'image avec
`OPENCLAW_DOCKER_APT_PACKAGES` au lieu d'utiliser `--with-deps` au moment de l'exécution.

4. **Persister les téléchargements de navigateur Playwright** :

- Définissez `PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright` dans
  `docker-compose.yml`.
- Assurez-vous que `/home/node` persiste via `OPENCLAW_HOME_VOLUME`, ou montez
  `/home/node/.cache/ms-playwright` via `OPENCLAW_EXTRA_MOUNTS`.

### Permissions + EACCES

L'image s'exécute en tant que `node` (uid 1000). Si vous voyez des erreurs de permission sur
`/home/node/.openclaw`, assurez-vous que vos montages de liaison hôte appartiennent à uid 1000.

Exemple (hôte Linux) :

```bash
sudo chown -R 1000:1000 /path/to/openclaw-config /path/to/openclaw-workspace
```

Si vous choisissez de vous exécuter en tant que root pour la commodité, vous acceptez le compromis de sécurité.

### Reconstructions plus rapides (recommandé)

Pour accélérer les reconstructions, ordonnez votre Dockerfile pour que les couches de dépendances soient mises en cache.
Cela évite de réexécuter `pnpm install` sauf si les fichiers de verrouillage changent :

```dockerfile
FROM node:22-bookworm

# Installer Bun (requis pour les scripts de construction)
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

RUN corepack enable

WORKDIR /app

# Mettre en cache les dépendances sauf si les métadonnées de paquet changent
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY ui/package.json ./ui/package.json
COPY scripts ./scripts

RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build
RUN pnpm ui:install
RUN pnpm ui:build

ENV NODE_ENV=production

CMD ["node","dist/index.js"]
```

### Configuration de canal (optionnel)

Utilisez le conteneur CLI pour configurer les canaux, puis redémarrez la passerelle si nécessaire.

WhatsApp (QR) :

```bash
docker compose run --rm openclaw-cli channels login
```

Telegram (token de bot) :

```bash
docker compose run --rm openclaw-cli channels add --channel telegram --token "<token>"
```

Discord (token de bot) :

```bash
docker compose run --rm openclaw-cli channels add --channel discord --token "<token>"
```

Docs : [WhatsApp](/fr-FR/channels/whatsapp), [Telegram](/fr-FR/channels/telegram), [Discord](/fr-FR/channels/discord)

### OAuth OpenAI Codex (Docker sans écran)

Si vous choisissez OAuth OpenAI Codex dans l'assistant, il ouvre une URL de navigateur et essaie
de capturer un rappel sur `http://127.0.0.1:1455/auth/callback`. Dans Docker ou
des configurations sans écran, ce rappel peut afficher une erreur de navigateur. Copiez l'URL de redirection
complète sur laquelle vous atterrissez et collez-la dans l'assistant pour terminer l'authentification.

### Vérification de santé

```bash
docker compose exec openclaw-gateway node dist/index.js health --token "$OPENCLAW_GATEWAY_TOKEN"
```

### Test de fumée E2E (Docker)

```bash
scripts/e2e/onboard-docker.sh
```

### Test de fumée d'import QR (Docker)

```bash
pnpm test:docker:qr
```

### Notes

- La liaison de passerelle par défaut est `lan` pour l'utilisation en conteneur.
- Le Dockerfile CMD utilise `--allow-unconfigured` ; la configuration montée avec `gateway.mode` non `local` démarrera quand même. Écrasez CMD pour imposer la garde.
- Le conteneur de passerelle est la source de vérité pour les sessions (`~/.openclaw/agents/<agentId>/sessions/`).

## sandbox d'agent (passerelle hôte + outils Docker)

Plongée profonde : [Isolation en sandbox](/fr-FR/gateway/sandboxing)

### Ce que ça fait

Quand `agents.defaults.sandbox` est activé, les **sessions non-main** exécutent les outils dans un
conteneur Docker. La passerelle reste sur votre hôte, mais l'exécution d'outil est isolée :

- scope : `"agent"` par défaut (un conteneur + espace de travail par agent)
- scope : `"session"` pour l'isolation par session
- dossier d'espace de travail par scope monté à `/workspace`
- accès optionnel à l'espace de travail agent (`agents.defaults.sandbox.workspaceAccess`)
- politique d'outil autoriser/refuser (refuser gagne)
- les médias entrants sont copiés dans l'espace de travail de sandbox actif (`media/inbound/*`) pour que les outils puissent les lire (avec `workspaceAccess: "rw"`, cela atterrit dans l'espace de travail agent)

Avertissement : `scope: "shared"` désactive l'isolation entre sessions. Toutes les sessions partagent
un conteneur et un espace de travail.

### Profils de sandbox par agent (multi-agent)

Si vous utilisez le routage multi-agent, chaque agent peut écraser les paramètres de sandbox + outil :
`agents.list[].sandbox` et `agents.list[].tools` (plus `agents.list[].tools.sandbox.tools`). Cela vous permet d'exécuter
des niveaux d'accès mixtes dans une passerelle :

- Accès complet (agent personnel)
- Outils lecture seule + espace de travail lecture seule (agent famille/travail)
- Pas d'outils système de fichiers/shell (agent public)

Voir [sandbox & outils multi-agent](/fr-FR/tools/multi-agent-sandbox-tools) pour les exemples,
la priorité et le dépannage.

### Comportement par défaut

- Image : `openclaw-sandbox:bookworm-slim`
- Un conteneur par agent
- Accès espace de travail agent : `workspaceAccess: "none"` (par défaut) utilise `~/.openclaw/sandboxes`
  - `"ro"` garde l'espace de travail de sandbox à `/workspace` et monte l'espace de travail agent en lecture seule à `/agent` (désactive `write`/`edit`/`apply_patch`)
  - `"rw"` monte l'espace de travail agent en lecture/écriture à `/workspace`
- Auto-élagage : inactif > 24h OU âge > 7j
- Réseau : `none` par défaut (opt-in explicite si vous avez besoin d'egress)
- Autorisation par défaut : `exec`, `process`, `read`, `write`, `edit`, `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status`
- Refus par défaut : `browser`, `canvas`, `nodes`, `cron`, `discord`, `gateway`

### Activer l'isolation en sandbox

Si vous prévoyez d'installer des paquets dans `setupCommand`, notez :

- Le `docker.network` par défaut est `"none"` (pas d'egress).
- `readOnlyRoot: true` bloque les installations de paquets.
- `user` doit être root pour `apt-get` (omettez `user` ou définissez `user: "0:0"`).
  OpenClaw recrée automatiquement les conteneurs quand `setupCommand` (ou la configuration docker) change
  sauf si le conteneur a été **récemment utilisé** (dans les ~5 minutes). Les conteneurs chauds
  enregistrent un avertissement avec la commande exacte `openclaw sandbox recreate ...`.

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main", // off | non-main | all
        scope: "agent", // session | agent | shared (agent est par défaut)
        workspaceAccess: "none", // none | ro | rw
        workspaceRoot: "~/.openclaw/sandboxes",
        docker: {
          image: "openclaw-sandbox:bookworm-slim",
          workdir: "/workspace",
          readOnlyRoot: true,
          tmpfs: ["/tmp", "/var/tmp", "/run"],
          network: "none",
          user: "1000:1000",
          capDrop: ["ALL"],
          env: { LANG: "C.UTF-8" },
          setupCommand: "apt-get update && apt-get install -y git curl jq",
          pidsLimit: 256,
          memory: "1g",
          memorySwap: "2g",
          cpus: 1,
          ulimits: {
            nofile: { soft: 1024, hard: 2048 },
            nproc: 256,
          },
          seccompProfile: "/path/to/seccomp.json",
          apparmorProfile: "openclaw-sandbox",
          dns: ["1.1.1.1", "8.8.8.8"],
          extraHosts: ["internal.service:10.0.0.5"],
        },
        prune: {
          idleHours: 24, // 0 désactive l'élagage inactif
          maxAgeDays: 7, // 0 désactive l'élagage par âge max
        },
      },
    },
  },
  tools: {
    sandbox: {
      tools: {
        allow: [
          "exec",
          "process",
          "read",
          "write",
          "edit",
          "sessions_list",
          "sessions_history",
          "sessions_send",
          "sessions_spawn",
          "session_status",
        ],
        deny: ["browser", "canvas", "nodes", "cron", "discord", "gateway"],
      },
    },
  },
}
```

Les boutons de renforcement se trouvent sous `agents.defaults.sandbox.docker` :
`network`, `user`, `pidsLimit`, `memory`, `memorySwap`, `cpus`, `ulimits`,
`seccompProfile`, `apparmorProfile`, `dns`, `extraHosts`.

Multi-agent : écrasez `agents.defaults.sandbox.{docker,browser,prune}.*` par agent via `agents.list[].sandbox.{docker,browser,prune}.*`
(ignoré quand `agents.defaults.sandbox.scope` / `agents.list[].sandbox.scope` est `"shared"`).

### Construire l'image de sandbox par défaut

```bash
scripts/sandbox-setup.sh
```

Cela construit `openclaw-sandbox:bookworm-slim` en utilisant `Dockerfile.sandbox`.

### Image commune de sandbox (optionnel)

Si vous voulez une image de sandbox avec des outils de construction communs (Node, Go, Rust, etc.), construisez l'image commune :

```bash
scripts/sandbox-common-setup.sh
```

Cela construit `openclaw-sandbox-common:bookworm-slim`. Pour l'utiliser :

```json5
{
  agents: {
    defaults: {
      sandbox: { docker: { image: "openclaw-sandbox-common:bookworm-slim" } },
    },
  },
}
```

### Image de navigateur de sandbox

Pour exécuter l'outil navigateur dans le sandbox, construisez l'image navigateur :

```bash
scripts/sandbox-browser-setup.sh
```

Cela construit `openclaw-sandbox-browser:bookworm-slim` en utilisant
`Dockerfile.sandbox-browser`. Le conteneur exécute Chromium avec CDP activé et
un observateur noVNC optionnel (avec écran via Xvfb).

Notes :

- Avec écran (Xvfb) réduit le blocage de bot vs sans écran.
- Sans écran peut toujours être utilisé en définissant `agents.defaults.sandbox.browser.headless=true`.
- Aucun environnement de bureau complet (GNOME) n'est nécessaire ; Xvfb fournit l'affichage.

Utilisez la configuration :

```json5
{
  agents: {
    defaults: {
      sandbox: {
        browser: { enabled: true },
      },
    },
  },
}
```

Image navigateur personnalisée :

```json5
{
  agents: {
    defaults: {
      sandbox: { browser: { image: "my-openclaw-browser" } },
    },
  },
}
```

Quand activé, l'agent reçoit :

- une URL de contrôle de navigateur de sandbox (pour l'outil `browser`)
- une URL noVNC (si activé et headless=false)

Rappelez-vous : si vous utilisez une liste d'autorisation pour les outils, ajoutez `browser` (et retirez-le de
deny) ou l'outil reste bloqué.
Les règles d'élagage (`agents.defaults.sandbox.prune`) s'appliquent aussi aux conteneurs de navigateur.

### Image de sandbox personnalisée

Construisez votre propre image et pointez la configuration vers elle :

```bash
docker build -t my-openclaw-sbx -f Dockerfile.sandbox .
```

```json5
{
  agents: {
    defaults: {
      sandbox: { docker: { image: "my-openclaw-sbx" } },
    },
  },
}
```

### Politique d'outil (autoriser/refuser)

- `deny` gagne sur `allow`.
- Si `allow` est vide : tous les outils (sauf deny) sont disponibles.
- Si `allow` est non vide : seuls les outils dans `allow` sont disponibles (moins deny).

### Stratégie d'élagage

Deux boutons :

- `prune.idleHours` : supprimer les conteneurs non utilisés depuis X heures (0 = désactiver)
- `prune.maxAgeDays` : supprimer les conteneurs de plus de X jours (0 = désactiver)

Exemple :

- Garder les sessions actives mais plafonner la durée de vie :
  `idleHours: 24`, `maxAgeDays: 7`
- Ne jamais élaguer :
  `idleHours: 0`, `maxAgeDays: 0`

### Notes de sécurité

- Le mur dur ne s'applique qu'aux **outils** (exec/read/write/edit/apply_patch).
- Les outils hôte uniquement comme browser/camera/canvas sont bloqués par défaut.
- Autoriser `browser` dans le sandbox **casse l'isolation** (le navigateur s'exécute sur l'hôte).

## Dépannage

- Image manquante : construire avec [`scripts/sandbox-setup.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/sandbox-setup.sh) ou définir `agents.defaults.sandbox.docker.image`.
- Conteneur non en cours d'exécution : il sera créé automatiquement par session à la demande.
- Erreurs de permission dans le sandbox : définir `docker.user` à un UID:GID qui correspond à la
  propriété de votre espace de travail monté (ou chown le dossier d'espace de travail).
- Outils personnalisés introuvables : OpenClaw exécute les commandes avec `sh -lc` (shell de connexion), qui
  source `/etc/profile` et peut réinitialiser PATH. Définissez `docker.env.PATH` pour préfixer vos
  chemins d'outils personnalisés (par ex., `/custom/bin:/usr/local/share/npm-global/bin`), ou ajoutez
  un script sous `/etc/profile.d/` dans votre Dockerfile.
