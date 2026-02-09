---
summary: "Mise à jour d’OpenClaw en toute sécurité (installation globale ou depuis la source), avec stratégie de retour arrière"
read_when:
  - Mise à jour d’OpenClaw
  - Quelque chose se casse après une mise à jour
title: "Mise à jour"
---

# Mise à jour

OpenClaw évolue rapidement (pré « 1.0 »). Traitez les mises à jour comme de l’infrastructure en production : mise à jour → exécuter les vérifications → redémarrer (ou utiliser `openclaw update`, qui redémarre) → vérifier.

## Recommandé : relancer l’installateur du site web (mise à niveau sur place)

Le chemin de mise à jour **préféré** consiste à relancer l’installateur depuis le site web. Il
détecte les installations existantes, met à niveau sur place et exécute `openclaw doctor` si nécessaire.

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

Notes :

- Ajoutez `--no-onboard` si vous ne voulez pas relancer l’assistant de prise en main.

- Pour les **installations depuis la source**, utilisez :

  ```bash
  curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git --no-onboard
  ```

  L’installateur effectuera `git pull --rebase` **uniquement** si le dépôt est propre.

- Pour les **installations globales**, le script utilise `npm install -g openclaw@latest` en interne.

- Note héritage : `clawdbot` reste disponible comme shim de compatibilité.

## Avant de mettre à jour

- Sachez comment vous avez installé : **global** (npm/pnpm) vs **depuis la source** (git clone).
- Sachez comment votre Gateway (passerelle) s’exécute : **terminal au premier plan** vs **service supervisé** (launchd/systemd).
- Instantané votre adaptation :
  - Config : `~/.openclaw/openclaw.json`
  - Identifiants : `~/.openclaw/credentials/`
  - Espace de travail : `~/.openclaw/workspace`

## Mise à jour (installation globale)

Installation globale (choisissez une option) :

```bash
npm i -g openclaw@latest
```

```bash
pnpm add -g openclaw@latest
```

Nous **ne** recommandons **pas** Bun pour l’exécution de la Gateway (passerelle) (bogues WhatsApp/Telegram).

Pour changer de canal de mise à jour (installations git + npm) :

```bash
openclaw update --channel beta
openclaw update --channel dev
openclaw update --channel stable
```

Utilisez `--tag <dist-tag|version>` pour une installation ponctuelle avec un tag/version.

Voir [Canaux de développement](/install/development-channels) pour la sémantique des canaux et les notes de version.

Note : pour les installations npm, la gateway journalise un indice de mise à jour au démarrage (vérifie le tag du canal courant). Désactivez via `update.checkOnStart: false`.

Puis :

```bash
openclaw doctor
openclaw gateway restart
openclaw health
```

Notes :

- Si votre Gateway (passerelle) s’exécute comme un service, `openclaw gateway restart` est préférable à l’arrêt manuel des PID.
- Si vous êtes épinglé à une version spécifique, voir « Retour arrière / épinglage » ci‑dessous.

## Mise à jour (`openclaw update`)

Pour les **installations depuis la source** (git checkout), privilégiez :

```bash
openclaw update
```

Cela exécute un flux de mise à jour « plutôt sûr » :

- Exige un arbre de travail propre.
- Bascule vers le canal sélectionné (tag ou branche).
- Récupère + rebase sur l’amont configuré (canal dev).
- Installe les dépendances, compile, construit l’UI de contrôle et exécute `openclaw doctor`.
- Redémarre la gateway par défaut (utilisez `--no-restart` pour ignorer).

Si vous avez installé via **npm/pnpm** (sans métadonnées git), `openclaw update` tentera de mettre à jour via votre gestionnaire de paquets. S’il ne peut pas détecter l’installation, utilisez plutôt « Mise à jour (installation globale) ».

## Mise à jour (UI de contrôle / RPC)

L’UI de contrôle propose **Update & Restart** (RPC : `update.run`). Elle :

1. Exécute le même flux de mise à jour depuis la source que `openclaw update` (git checkout uniquement).
2. Écrit un sentinelle de redémarrage avec un rapport structuré (fin de stdout/stderr).
3. Redémarre la gateway et notifie la dernière session active avec le rapport.

Si le rebase échoue, la gateway abandonne et redémarre sans appliquer la mise à jour.

## Mise à jour (depuis la source)

Depuis le checkout du dépôt :

Préféré :

```bash
openclaw update
```

Manuel (équivalent-ish) :

```bash
git pull
pnpm install
pnpm build
pnpm ui:build # auto-installs UI deps on first run
openclaw doctor
openclaw health
```

Notes :

- `pnpm build` compte lorsque vous exécutez le binaire `openclaw` empaqueté ([`openclaw.mjs`](https://github.com/openclaw/openclaw/blob/main/openclaw.mjs)) ou utilisez Node pour exécuter `dist/`.
- Si vous exécutez depuis un checkout du dépôt sans installation globale, utilisez `pnpm openclaw ...` pour les commandes CLI.
- Si vous exécutez directement depuis TypeScript (`pnpm openclaw ...`), une reconstruction est généralement inutile, mais **les migrations de configuration s’appliquent toujours** → exécutez doctor.
- Passer d’installations globales à git (et inversement) est simple : installez l’autre variante, puis exécutez `openclaw doctor` afin que le point d’entrée du service gateway soit réécrit vers l’installation courante.

## À exécuter systématiquement : `openclaw doctor`

Doctor est la commande de « mise à jour sûre ». Elle est volontairement ennuyeuse : réparer + migrer + avertir.

Note : si vous êtes sur une **installation depuis la source** (git checkout), `openclaw doctor` proposera d’exécuter `openclaw update` d’abord.

Actions typiques :

- Migrer les clés de configuration obsolètes / emplacements de fichiers de configuration hérités.
- Auditer les politiques de Messages prives et avertir des réglages « ouverts » risqués.
- Vérifier l’état de la Gateway (passerelle) et proposer un redémarrage.
- Détecter et migrer d’anciens services gateway (launchd/systemd ; anciens schtasks) vers les services OpenClaw actuels.
- Sous Linux, s’assurer du lingering utilisateur systemd (pour que la Gateway survive à la déconnexion).

Détails : [Doctor](/gateway/doctor)

## Démarrer / arrêter / redémarrer la Gateway (passerelle)

CLI (fonctionne quel que soit l’OS) :

```bash
openclaw gateway status
openclaw gateway stop
openclaw gateway restart
openclaw gateway --port 18789
openclaw logs --follow
```

Si vous êtes supervisé :

- macOS launchd (LaunchAgent empaqueté dans l’app) : `launchctl kickstart -k gui/$UID/bot.molt.gateway` (utilisez `bot.molt.<profile>` ; l’historique `com.openclaw.*` fonctionne encore)
- Linux systemd user service : `systemctl --user restart openclaw-gateway[-<profile>].service`
- Windows (WSL2) : `systemctl --user restart openclaw-gateway[-<profile>].service`
  - `launchctl`/`systemctl` ne fonctionnent que si le service est installé ; sinon exécutez `openclaw gateway install`.

Runbook + libellés exacts des services : [Runbook de la Gateway](/gateway)

## Retour arrière / épinglage (quand quelque chose se casse)

### Épingler (installation globale)

Installez une version connue comme fonctionnelle (remplacez `<version>` par la dernière qui marchait) :

```bash
npm i -g openclaw@<version>
```

```bash
pnpm add -g openclaw@<version>
```

Astuce : pour voir la version actuellement publiée, exécutez `npm view openclaw version`.

Puis redémarrez + relancez doctor :

```bash
openclaw doctor
openclaw gateway restart
```

### Épingler (source) par date

Choisissez un commit à une date donnée (exemple : « état de main au 2026‑01‑01 ») :

```bash
git fetch origin
git checkout "$(git rev-list -n 1 --before=\"2026-01-01\" origin/main)"
```

Puis réinstallez les dépendances + redémarrez :

```bash
pnpm install
pnpm build
openclaw gateway restart
```

Si vous voulez revenir au plus récent plus tard :

```bash
git checkout main
git pull
```

## Si vous êtes bloqué

- Exécutez à nouveau `openclaw doctor` et lisez attentivement la sortie (elle indique souvent la correction).
- Consultez : [Depannage](/gateway/troubleshooting)
- Demandez sur Discord : https://discord.gg/clawd
