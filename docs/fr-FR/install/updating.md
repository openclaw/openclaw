---
summary: "Mettre à jour OpenClaw en toute sécurité (installation globale ou source), plus stratégie de restauration"
read_when:
  - Mise à jour d'OpenClaw
  - Quelque chose ne fonctionne plus après une mise à jour
title: "Mise à jour"
---

# Mise à jour

OpenClaw évolue rapidement (avant "1.0"). Traitez les mises à jour comme de l'infrastructure de déploiement : mettre à jour → exécuter les vérifications → redémarrer (ou utiliser `openclaw update`, qui redémarre) → vérifier.

## Recommandé : réexécuter l'installateur du site web (mise à niveau sur place)

Le chemin de mise à jour **préféré** est de réexécuter l'installateur depuis le site web. Il détecte les installations existantes, met à niveau sur place et exécute `openclaw doctor` si nécessaire.

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

Notes :

- Ajoutez `--no-onboard` si vous ne voulez pas que l'assistant d'intégration s'exécute à nouveau.
- Pour les **installations depuis la source**, utilisez :

  ```bash
  curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git --no-onboard
  ```

  L'installateur fera `git pull --rebase` **seulement** si le dépôt est propre.

- Pour les **installations globales**, le script utilise `npm install -g openclaw@latest` sous le capot.
- Note héritée : `clawdbot` reste disponible comme shim de compatibilité.

## Avant de mettre à jour

- Sachez comment vous avez installé : **global** (npm/pnpm) vs **depuis la source** (git clone).
- Sachez comment votre passerelle s'exécute : **terminal en premier plan** vs **service supervisé** (launchd/systemd).
- Sauvegardez votre personnalisation :
  - Configuration : `~/.openclaw/openclaw.json`
  - Identifiants : `~/.openclaw/credentials/`
  - Espace de travail : `~/.openclaw/workspace`

## Mise à jour (installation globale)

Installation globale (choisissez-en une) :

```bash
npm i -g openclaw@latest
```

```bash
pnpm add -g openclaw@latest
```

Nous ne recommandons **pas** Bun pour l'environnement d'exécution de la passerelle (bugs WhatsApp/Telegram).

Pour changer de canal de mise à jour (installations git + npm) :

```bash
openclaw update --channel beta
openclaw update --channel dev
openclaw update --channel stable
```

Utilisez `--tag <dist-tag|version>` pour une installation de tag/version ponctuelle.

Consultez [Canaux de développement](/fr-FR/install/development-channels) pour la sémantique des canaux et les notes de version.

Note : sur les installations npm, la passerelle affiche une indication de mise à jour au démarrage (vérifie le tag du canal actuel). Désactivez via `update.checkOnStart: false`.

Puis :

```bash
openclaw doctor
openclaw gateway restart
openclaw health
```

Notes :

- Si votre passerelle s'exécute comme un service, `openclaw gateway restart` est préférable à tuer les PID.
- Si vous êtes épinglé à une version spécifique, consultez "Restauration / épinglage" ci-dessous.

## Mise à jour (`openclaw update`)

Pour les **installations depuis la source** (checkout git), préférez :

```bash
openclaw update
```

Il exécute un flux de mise à jour relativement sûr :

- Nécessite un arbre de travail propre.
- Bascule vers le canal sélectionné (tag ou branche).
- Récupère + rebase contre l'upstream configuré (canal dev).
- Installe les dépendances, construit, construit l'interface de contrôle et exécute `openclaw doctor`.
- Redémarre la passerelle par défaut (utilisez `--no-restart` pour ignorer).

Si vous avez installé via **npm/pnpm** (pas de métadonnées git), `openclaw update` essaiera de mettre à jour via votre gestionnaire de paquets. S'il ne peut pas détecter l'installation, utilisez plutôt "Mise à jour (installation globale)".

## Mise à jour (Interface de contrôle / RPC)

L'interface de contrôle a **Update & Restart** (RPC : `update.run`). Elle :

1. Exécute le même flux de mise à jour source que `openclaw update` (checkout git uniquement).
2. Écrit une sentinelle de redémarrage avec un rapport structuré (queue stdout/stderr).
3. Redémarre la passerelle et envoie un ping à la dernière session active avec le rapport.

Si le rebase échoue, la passerelle abandonne et redémarre sans appliquer la mise à jour.

## Mise à jour (depuis la source)

Depuis le checkout du dépôt :

Préféré :

```bash
openclaw update
```

Manuel (équivalent) :

```bash
git pull
pnpm install
pnpm build
pnpm ui:build # installe automatiquement les dépendances UI à la première exécution
openclaw doctor
openclaw health
```

Notes :

- `pnpm build` compte quand vous exécutez le binaire `openclaw` packagé ([`openclaw.mjs`](https://github.com/openclaw/openclaw/blob/main/openclaw.mjs)) ou utilisez Node pour exécuter `dist/`.
- Si vous exécutez depuis un checkout de dépôt sans installation globale, utilisez `pnpm openclaw ...` pour les commandes CLI.
- Si vous exécutez directement depuis TypeScript (`pnpm openclaw ...`), une reconstruction est généralement inutile, mais **les migrations de configuration s'appliquent toujours** → exécutez doctor.
- Basculer entre les installations globales et git est facile : installez l'autre variante, puis exécutez `openclaw doctor` pour que le point d'entrée du service de passerelle soit réécrit vers l'installation actuelle.

## Toujours exécuter : `openclaw doctor`

Doctor est la commande de "mise à jour sûre". C'est intentionnellement ennuyeux : réparer + migrer + avertir.

Note : si vous êtes sur une **installation depuis la source** (checkout git), `openclaw doctor` proposera d'exécuter d'abord `openclaw update`.

Choses typiques qu'il fait :

- Migrer les clés de configuration obsolètes / emplacements de fichier de configuration hérités.
- Auditer les politiques DM et avertir sur les paramètres "ouverts" risqués.
- Vérifier la santé de la passerelle et peut proposer de redémarrer.
- Détecter et migrer les anciens services de passerelle (launchd/systemd ; schtasks héritées) vers les services OpenClaw actuels.
- Sur Linux, assurer la persistance utilisateur systemd (pour que la passerelle survive à la déconnexion).

Détails : [Doctor](/fr-FR/gateway/doctor)

## Démarrer / arrêter / redémarrer la passerelle

CLI (fonctionne quel que soit l'OS) :

```bash
openclaw gateway status
openclaw gateway stop
openclaw gateway restart
openclaw gateway --port 18789
openclaw logs --follow
```

Si vous êtes supervisé :

- macOS launchd (LaunchAgent intégré à l'application) : `launchctl kickstart -k gui/$UID/bot.molt.gateway` (utilisez `bot.molt.<profile>` ; l'ancien `com.openclaw.*` fonctionne toujours)
- Service utilisateur Linux systemd : `systemctl --user restart openclaw-gateway[-<profile>].service`
- Windows (WSL2) : `systemctl --user restart openclaw-gateway[-<profile>].service`
  - `launchctl`/`systemctl` fonctionnent uniquement si le service est installé ; sinon exécutez `openclaw gateway install`.

Guide d'exploitation + labels de service exacts : [Guide de la passerelle](/fr-FR/gateway)

## Restauration / épinglage (quand quelque chose casse)

### Épingler (installation globale)

Installez une version connue fonctionnelle (remplacez `<version>` par la dernière qui fonctionnait) :

```bash
npm i -g openclaw@<version>
```

```bash
pnpm add -g openclaw@<version>
```

Astuce : pour voir la version publiée actuelle, exécutez `npm view openclaw version`.

Puis redémarrez + réexécutez doctor :

```bash
openclaw doctor
openclaw gateway restart
```

### Épingler (source) par date

Choisissez un commit d'une date (exemple : "état de main au 2026-01-01") :

```bash
git fetch origin
git checkout "$(git rev-list -n 1 --before=\"2026-01-01\" origin/main)"
```

Puis réinstallez les dépendances + redémarrez :

```bash
pnpm install
pnpm build
openclaw gateway restart
```

Si vous voulez revenir au dernier plus tard :

```bash
git checkout main
git pull
```

## Si vous êtes bloqué

- Exécutez `openclaw doctor` à nouveau et lisez attentivement la sortie (elle vous dit souvent la correction).
- Vérifiez : [Dépannage](/fr-FR/gateway/troubleshooting)
- Demandez sur Discord : [https://discord.gg/clawd](https://discord.gg/clawd)
