---
summary: "Configuration et prise en main facultatives d’OpenClaw basées sur Docker"
read_when:
  - Vous voulez une passerelle conteneurisée plutôt que des installations locales
  - Vous validez le flux Docker
title: "Docker"
---

# Docker (facultatif)

Docker est **facultatif**. Utilisez-le uniquement si vous voulez une passerelle conteneurisée ou valider le flux Docker.

## Docker est-il fait pour moi ?

- **Oui** : vous voulez un environnement de passerelle isolé et jetable, ou exécuter OpenClaw sur un hôte sans installations locales.
- **Non** : vous travaillez sur votre propre machine et voulez simplement la boucle de développement la plus rapide. Utilisez plutôt le flux d’installation normal.
- **Note sur le sandboxing** : le sandboxing des agents utilise aussi Docker, mais il **n’exige pas** que la passerelle complète s’exécute dans Docker. Voir [Sandboxing](/gateway/sandboxing).

Ce guide couvre :

- Passerelle conteneurisée (OpenClaw complet dans Docker)
- Sandbox d’agent par session (passerelle sur l’hôte + outils d’agent isolés par Docker)

Détails sur le sandboxing : [Sandboxing](/gateway/sandboxing)

## Exigences

- Docker Desktop (ou Docker Engine) + Docker Compose v2
- Espace disque suffisant pour les images et les journaux

## Passerelle conteneurisée (Docker Compose)

### Demarrage rapide (recommandé)

Depuis la racine du dépôt :

```bash
./docker-setup.sh
```

Ce script :

- construit l’image de la passerelle
- exécute l'assistant d'intégration
- affiche des conseils facultatifs de configuration des fournisseurs
- démarre la passerelle via Docker Compose
- génère un jeton de passerelle et l’écrit dans `.env`

Variables de l'env optionnelles :

- `OPENCLAW_DOCKER_APT_PACKAGES` — installer des paquets apt supplémentaires lors du build
- `OPENCLAW_EXTRA_MOUNTS` — ajouter des montages bind hôte supplémentaires
- `OPENCLAW_HOME_VOLUME` — persister `/home/node` dans un volume nommé

Une fois terminé :

- Ouvrez `http://127.0.0.1:18789/` dans votre navigateur.
- Collez le jeton dans l’UI de contrôle (Settings → token).
- Besoin à nouveau de l’URL ? Exécutez `docker compose run --rm openclaw-cli dashboard --no-open`.

Il écrit la configuration et l’espace de travail sur l’hôte :

- `~/.openclaw/`
- `~/.openclaw/workspace`

Vous tournez sur un VPS ? Voir [Hetzner (Docker VPS)](/install/hetzner).

### Flux manuel (compose)

```bash
docker build -t openclaw:local -f Dockerfile .
docker compose run --rm openclaw-cli onboard
docker compose up -d openclaw-gateway
```

Note : exécutez `docker compose ...` depuis la racine du dépôt. Si vous avez activé
`OPENCLAW_EXTRA_MOUNTS` ou `OPENCLAW_HOME_VOLUME`, le script de configuration écrit
`docker-compose.extra.yml` ; incluez-le lorsque vous exécutez Compose ailleurs :

```bash
docker compose -f docker-compose.yml -f docker-compose.extra.yml <command>
```

### Jeton de l’UI de contrôle + appairage (Docker)

Si vous voyez « unauthorized » ou « disconnected (1008): pairing required », récupérez un
nouveau lien de tableau de bord et approuvez l’appareil navigateur :

```bash
docker compose run --rm openclaw-cli dashboard --no-open
docker compose run --rm openclaw-cli devices list
docker compose run --rm openclaw-cli devices approve <requestId>
```

Plus de détails : [Dashboard](/web/dashboard), [Devices](/cli/devices).

### Montages supplémentaires (facultatif)

Si vous voulez monter des répertoires hôte supplémentaires dans les conteneurs, définissez
`OPENCLAW_EXTRA_MOUNTS` avant d’exécuter `docker-setup.sh`. Cela accepte une liste séparée par des
virgules de montages bind Docker et les applique à la fois à
`openclaw-gateway` et `openclaw-cli` en générant `docker-compose.extra.yml`.

Exemple :

```bash
export OPENCLAW_EXTRA_MOUNTS="$HOME/.codex:/home/node/.codex:ro,$HOME/github:/home/node/github:rw"
./docker-setup.sh
```

Notes :

- Les chemins doivent être partagés avec Docker Desktop sur macOS/Windows.
- Si vous modifiez `OPENCLAW_EXTRA_MOUNTS`, relancez `docker-setup.sh` pour régénérer le
  fichier compose supplémentaire.
- `docker-compose.extra.yml` est généré. Ne l’éditez pas à la main.

### Persister l’intégralité du home du conteneur (facultatif)

Si vous voulez que `/home/node` persiste lors de la recréation des conteneurs, définissez un
volume nommé via `OPENCLAW_HOME_VOLUME`. Cela crée un volume Docker et le monte sur
`/home/node`, tout en conservant les montages bind standards de config/espace de travail. Utilisez ici un volume nommé (pas un chemin bind) ; pour les montages bind, utilisez
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

- Si vous changez `OPENCLAW_HOME_VOLUME`, relancez `docker-setup.sh` pour régénérer le
  fichier compose supplémentaire.
- Le volume nommé persiste jusqu’à sa suppression avec `docker volume rm <name>`.

### Installer des paquets apt supplémentaires (facultatif)

Si vous avez besoin de paquets système dans l’image (par exemple des outils de build ou des
bibliothèques multimédias), définissez `OPENCLAW_DOCKER_APT_PACKAGES` avant d’exécuter `docker-setup.sh`.
Cela installe les paquets pendant le build de l’image, de sorte qu’ils persistent même si le
conteneur est supprimé.

Exemple :

```bash
export OPENCLAW_DOCKER_APT_PACKAGES="ffmpeg build-essential"
./docker-setup.sh
```

Notes :

- Accepte une liste de noms de paquets apt séparés par des espaces.
- Si vous modifiez `OPENCLAW_DOCKER_APT_PACKAGES`, relancez `docker-setup.sh` pour reconstruire
  l’image.

### Conteneur « power-user » / fonctionnalités complètes (opt-in)

L’image Docker par défaut est **axée sécurité** et s’exécute en tant qu’utilisateur non-root
`node`. Cela réduit la surface d’attaque, mais implique :

- pas d’installation de paquets système à l’exécution
- pas de Homebrew par défaut
- pas de navigateurs Chromium/Playwright inclus

Si vous voulez un conteneur plus complet, utilisez ces options opt-in :

1. **Persister `/home/node`** afin que les téléchargements de navigateurs et les caches
   d’outils survivent :

```bash
export OPENCLAW_HOME_VOLUME="openclaw_home"
./docker-setup.sh
```

2. **Intégrer les dépendances système dans l’image** (répétable + persistant) :

```bash
export OPENCLAW_DOCKER_APT_PACKAGES="git curl jq"
./docker-setup.sh
```

3. **Installer les navigateurs Playwright sans `npx`** (évite les conflits
   d’override npm) :

```bash
docker compose run --rm openclaw-cli \
  node /app/node_modules/playwright-core/cli.js install chromium
```

Si vous avez besoin que Playwright installe des dépendances système, reconstruisez l’image avec
`OPENCLAW_DOCKER_APT_PACKAGES` au lieu d’utiliser `--with-deps` à l’exécution.

4. **Persister les téléchargements de navigateurs Playwright** :

- Définissez `PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright` dans
  `docker-compose.yml`.
- Assurez-vous que `/home/node` persiste via `OPENCLAW_HOME_VOLUME`, ou montez
  `/home/node/.cache/ms-playwright` via `OPENCLAW_EXTRA_MOUNTS`.

### Permissions + EACCES

L’image s’exécute en tant que `node` (uid 1000). Si vous voyez des erreurs de
permissions sur `/home/node/.openclaw`, assurez-vous que vos montages bind hôte appartiennent à l’uid 1000.

Exemple (hôte Linux) :

```bash
sudo chown -R 1000:1000 /path/to/openclaw-config /path/to/openclaw-workspace
```

Si vous choisissez de vous exécuter en root par commodité, vous acceptez le compromis de
sécurité.

### Rebuilds plus rapides (recommandé)

Pour accélérer les rebuilds, ordonnez votre Dockerfile de sorte que les couches de dépendances
soient mises en cache.
Cela évite de relancer `pnpm install` tant que les lockfiles ne changent
pas :

```dockerfile
FROM node:22-bookworm

# Install Bun (required for build scripts)
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

RUN corepack enable

WORKDIR /app

# Cache dependencies unless package metadata changes
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

### Configuration des canaux (facultatif)

Utilisez le conteneur CLI pour configurer les canaux, puis redémarrez la passerelle si
nécessaire.

WhatsApp (QR) :

```bash
docker compose run --rm openclaw-cli channels login
```

Telegram (jeton de bot) :

```bash
docker compose run --rm openclaw-cli channels add --channel telegram --token "<token>"
```

Discord (jeton de bot) :

```bash
docker compose run --rm openclaw-cli channels add --channel discord --token "<token>"
```

Docs : [WhatsApp](/channels/whatsapp), [Telegram](/channels/telegram), [Discord](/channels/discord)

### OAuth OpenAI Codex (Docker headless)

Si vous choisissez OAuth OpenAI Codex dans l’assistant, il ouvre une URL de navigateur et tente
de capturer un callback sur `http://127.0.0.1:1455/auth/callback`. Dans Docker ou des configurations headless, ce
callback peut afficher une erreur de navigateur. Copiez l’URL de redirection complète sur
laquelle vous arrivez et collez-la dans l’assistant pour terminer l’authentification.

### Bilan de santé

```bash
docker compose exec openclaw-gateway node dist/index.js health --token "$OPENCLAW_GATEWAY_TOKEN"
```

### Test de fumée E2E (Docker)

```bash
scripts/e2e/onboard-docker.sh
```

### Test de fumée d’import QR (Docker)

```bash
pnpm test:docker:qr
```

### Notes

- Le bind de la passerelle utilise par défaut `lan` pour l’usage en conteneur.
- Le CMD du Dockerfile utilise `--allow-unconfigured` ; une configuration montée avec
  `gateway.mode` et non `local` démarrera quand même. Surchargez CMD pour imposer la
  garde.
- Le conteneur de passerelle est la source de vérité pour les sessions (`~/.openclaw/agents/<agentId>/sessions/`).

## Sandbox d’agent (passerelle sur l’hôte + outils Docker)

Approfondissement : [Sandboxing](/gateway/sandboxing)

### Ce que cela fait

Lorsque `agents.defaults.sandbox` est activé, les **sessions non principales** exécutent les outils dans
un conteneur Docker. La passerelle reste sur votre hôte, mais l’exécution des outils est
isolée :

- portée : `"agent"` par défaut (un conteneur + espace de travail par agent)
- portée : `"session"` pour une isolation par session
- dossier d’espace de travail par portée monté sur `/workspace`
- accès facultatif à l’espace de travail de l’agent (`agents.defaults.sandbox.workspaceAccess`)
- politique d’outils autoriser/refuser (le refus l’emporte)
- les médias entrants sont copiés dans l’espace de travail actif du sandbox
  (`media/inbound/*`) afin que les outils puissent les lire (avec `workspaceAccess: "rw"`, cela arrive
  dans l’espace de travail de l’agent)

Avertissement : `scope: "shared"` désactive l’isolation inter-sessions. Toutes les sessions
partagent un conteneur et un espace de travail.

### Profils de sandbox par agent (multi-agent)

Si vous utilisez le routage multi-agent, chaque agent peut surcharger les paramètres de
sandbox et d’outils : `agents.list[].sandbox` et `agents.list[].tools` (plus `agents.list[].tools.sandbox.tools`). Cela permet
d’exécuter des niveaux d’accès mixtes dans une même passerelle :

- Accès complet (agent personnel)
- Outils en lecture seule + espace de travail en lecture seule (agent famille/travail)
- Aucun outil de système de fichiers/shell (agent public)

Voir [Multi-Agent Sandbox & Tools](/multi-agent-sandbox-tools) pour des exemples, la
précédence et le dépannage.

### Comportement par défaut

- Image : `openclaw-sandbox:bookworm-slim`
- Un conteneur par agent
- Accès à l’espace de travail de l’agent : `workspaceAccess: "none"` (par défaut) utilise
  `~/.openclaw/sandboxes`
  - `"ro"` conserve l’espace de travail du sandbox sur `/workspace` et monte
    l’espace de travail de l’agent en lecture seule sur `/agent` (désactive
    `write`/`edit`/`apply_patch`)
  - `"rw"` monte l’espace de travail de l’agent en lecture/écriture sur
    `/workspace`
- Auto-prune : inactif > 24 h OU âge > 7 j
- Réseau : `none` par défaut (opt-in explicite si vous avez besoin de sortie)
- Autorisations par défaut : `exec`, `process`, `read`,
  `write`, `edit`, `sessions_list`, `sessions_history`,
  `sessions_send`, `sessions_spawn`, `session_status`
- Refus par défaut : `browser`, `canvas`, `nodes`, `cron`,
  `discord`, `gateway`

### Activer le sandboxing

Si vous prévoyez d’installer des paquets dans `setupCommand`, notez :

- Le `docker.network` par défaut est `"none"` (pas de sortie).
- `readOnlyRoot: true` bloque les installations de paquets.
- `user` doit être root pour `apt-get` (omettre `user` ou définir
  `user: "0:0"`).
  OpenClaw recrée automatiquement les conteneurs lorsque `setupCommand` (ou la config Docker)
  change, sauf si le conteneur a été **utilisé récemment** (dans les ~5 minutes). Les
  conteneurs « chauds » consignent un avertissement avec la commande `openclaw sandbox recreate ...` exacte.

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main", // off | non-main | all
        scope: "agent", // session | agent | shared (agent is default)
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
          idleHours: 24, // 0 disables idle pruning
          maxAgeDays: 7, // 0 disables max-age pruning
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

Les options de durcissement se trouvent sous `agents.defaults.sandbox.docker` :
`network`, `user`, `pidsLimit`, `memory`, `memorySwap`,
`cpus`, `ulimits`, `seccompProfile`, `apparmorProfile`,
`dns`, `extraHosts`.

Multi-agent : surchargez `agents.defaults.sandbox.{docker,browser,prune}.*` par agent via `agents.list[].sandbox.{docker,browser,prune}.*`
(ignoré lorsque `agents.defaults.sandbox.scope` / `agents.list[].sandbox.scope` est `"shared"`).

### Construire l’image de sandbox par défaut

```bash
scripts/sandbox-setup.sh
```

Cela construit `openclaw-sandbox:bookworm-slim` en utilisant `Dockerfile.sandbox`.

### Image commune de sandbox (facultatif)

Si vous voulez une image de sandbox avec des outils de build courants (Node, Go, Rust, etc.),
construisez l’image commune :

```bash
scripts/sandbox-common-setup.sh
```

Cela construit `openclaw-sandbox-common:bookworm-slim`. Pour l’utiliser :

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

Pour exécuter l’outil de navigateur dans le sandbox, construisez l’image de navigateur :

```bash
scripts/sandbox-browser-setup.sh
```

Cela construit `openclaw-sandbox-browser:bookworm-slim` en utilisant
`Dockerfile.sandbox-browser`. Le conteneur exécute Chromium avec CDP activé et
un observateur noVNC facultatif (headful via Xvfb).

Notes :

- Le mode headful (Xvfb) réduit le blocage des bots par rapport au headless.
- Le mode headless peut toujours être utilisé en définissant `agents.defaults.sandbox.browser.headless=true`.
- Aucun environnement de bureau complet (GNOME) n’est nécessaire ; Xvfb fournit l’affichage.

Utiliser la configuration :

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

Image de navigateur personnalisée :

```json5
{
  agents: {
    defaults: {
      sandbox: { browser: { image: "my-openclaw-browser" } },
    },
  },
}
```

Lorsque c’est activé, l’agent reçoit :

- une URL de contrôle du navigateur sandbox (pour l’outil `browser`)
- une URL noVNC (si activée et headless=false)

Rappel : si vous utilisez une liste d’autorisation d’outils, ajoutez `browser` (et
retirez-le du refus) sinon l’outil reste bloqué.
Les règles de purge (`agents.defaults.sandbox.prune`) s’appliquent aussi aux conteneurs de navigateur.

### Image de sandbox personnalisée

Construisez votre propre image et pointez la configuration dessus :

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

### Politique d’outils (autoriser/refuser)

- `deny` l’emporte sur `allow`.
- Si `allow` est vide : tous les outils (sauf ceux refusés) sont disponibles.
- Si `allow` n’est pas vide : seuls les outils dans `allow` sont disponibles
  (moins ceux refusés).

### Stratégie de purge

Deux paramètres :

- `prune.idleHours` : supprimer les conteneurs non utilisés depuis X heures (0 = désactiver)
- `prune.maxAgeDays` : supprimer les conteneurs plus anciens que X jours (0 = désactiver)

Exemple :

- Conserver les sessions actives mais plafonner la durée de vie :
  `idleHours: 24`, `maxAgeDays: 7`
- Ne jamais purger :
  `idleHours: 0`, `maxAgeDays: 0`

### Notes de sécurité

- La barrière dure s’applique uniquement aux **outils** (exec/read/write/edit/apply_patch).
- Les outils côté hôte comme browser/camera/canvas sont bloqués par défaut.
- Autoriser `browser` dans le sandbox **brise l’isolation** (le navigateur s’exécute sur
  l’hôte).

## Problemes courants

- Image manquante : construisez-la avec [`scripts/sandbox-setup.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/sandbox-setup.sh) ou définissez `agents.defaults.sandbox.docker.image`.
- Conteneur non démarré : il sera créé automatiquement par session à la demande.
- Erreurs de permissions dans le sandbox : définissez `docker.user` sur un UID:GID qui
  correspond au propriétaire de votre espace de travail monté (ou faites un chown du dossier
  d’espace de travail).
- Outils personnalisés introuvables : OpenClaw exécute les commandes avec `sh -lc`
  (login shell), qui source `/etc/profile` et peut réinitialiser PATH. Définissez
  `docker.env.PATH` pour préfixer vos chemins d’outils personnalisés (par exemple,
  `/custom/bin:/usr/local/share/npm-global/bin`), ou ajoutez un script sous `/etc/profile.d/` dans votre Dockerfile.
