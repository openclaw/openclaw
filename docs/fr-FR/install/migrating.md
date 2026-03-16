---
summary: "Déplacer (migrer) une installation OpenClaw d'une machine à une autre"
read_when:
  - Vous déplacez OpenClaw vers un nouvel ordinateur portable/serveur
  - Vous voulez préserver les sessions, l'authentification et les connexions de canal (WhatsApp, etc.)
title: "Guide de migration"
---

# Migrer OpenClaw vers une nouvelle machine

Ce guide migre une Passerelle OpenClaw d'une machine à une autre **sans refaire l'intégration**.

La migration est simple conceptuellement :

- Copier le **répertoire d'état** (`$OPENCLAW_STATE_DIR`, par défaut : `~/.openclaw/`) — cela inclut la configuration, l'authentification, les sessions et l'état du canal.
- Copier votre **espace de travail** (`~/.openclaw/workspace/` par défaut) — cela inclut vos fichiers d'agent (mémoire, invites, etc.).

Mais il y a des pièges courants autour des **profils**, **permissions** et **copies partielles**.

## Avant de commencer (ce que vous migrez)

### 1) Identifier votre répertoire d'état

La plupart des installations utilisent le par défaut :

- **Répertoire d'état :** `~/.openclaw/`

Mais il peut être différent si vous utilisez :

- `--profile <nom>` (devient souvent `~/.openclaw-<profil>/`)
- `OPENCLAW_STATE_DIR=/chemin/quelconque`

Si vous n'êtes pas sûr, exécutez sur l'**ancienne** machine :

```bash
openclaw status
```

Cherchez des mentions de `OPENCLAW_STATE_DIR` / profil dans la sortie. Si vous exécutez plusieurs passerelles, répétez pour chaque profil.

### 2) Identifier votre espace de travail

Valeurs par défaut courantes :

- `~/.openclaw/workspace/` (espace de travail recommandé)
- un dossier personnalisé que vous avez créé

Votre espace de travail est l'endroit où vivent des fichiers comme `MEMORY.md`, `USER.md` et `memory/*.md`.

### 3) Comprendre ce que vous allez préserver

Si vous copiez **à la fois** le répertoire d'état et l'espace de travail, vous conservez :

- Configuration de la passerelle (`openclaw.json`)
- Profils d'authentification / clés API / jetons OAuth
- Historique de session + état de l'agent
- État du canal (par exemple connexion/session WhatsApp)
- Vos fichiers d'espace de travail (mémoire, notes de compétences, etc.)

Si vous copiez **uniquement** l'espace de travail (par exemple via Git), vous ne préservez **pas** :

- sessions
- identifiants
- connexions de canal

Ceux-ci vivent sous `$OPENCLAW_STATE_DIR`.

## Étapes de migration (recommandées)

### Étape 0 — Faire une sauvegarde (ancienne machine)

Sur l'**ancienne** machine, arrêtez d'abord la passerelle pour que les fichiers ne changent pas pendant la copie :

```bash
openclaw gateway stop
```

(Optionnel mais recommandé) archiver le répertoire d'état et l'espace de travail :

```bash
# Ajustez les chemins si vous utilisez un profil ou des emplacements personnalisés
cd ~
tar -czf openclaw-state.tgz .openclaw

tar -czf openclaw-workspace.tgz .openclaw/workspace
```

Si vous avez plusieurs profils/répertoires d'état (par exemple `~/.openclaw-main`, `~/.openclaw-work`), archivez chacun.

### Étape 1 — Installer OpenClaw sur la nouvelle machine

Sur la **nouvelle** machine, installez le CLI (et Node si nécessaire) :

- Voir : [Installer](/fr-FR/install)

À ce stade, c'est normal si l'intégration crée un nouveau `~/.openclaw/` — vous le remplacerez à l'étape suivante.

### Étape 2 — Copier le répertoire d'état + espace de travail vers la nouvelle machine

Copiez **les deux** :

- `$OPENCLAW_STATE_DIR` (par défaut `~/.openclaw/`)
- votre espace de travail (par défaut `~/.openclaw/workspace/`)

Approches courantes :

- `scp` les archives tar et extraire
- `rsync -a` sur SSH
- disque externe

Après la copie, assurez-vous que :

- Les répertoires cachés ont été inclus (par exemple `.openclaw/`)
- La propriété des fichiers est correcte pour l'utilisateur exécutant la passerelle

### Étape 3 — Exécuter Doctor (migrations + réparation de service)

Sur la **nouvelle** machine :

```bash
openclaw doctor
```

Doctor est la commande "sûre et ennuyeuse". Elle répare les services, applique les migrations de configuration et avertit des incompatibilités.

Puis :

```bash
openclaw gateway restart
openclaw status
```

## Pièges courants (et comment les éviter)

### Piège : profil / incompatibilité de répertoire d'état

Si vous avez exécuté l'ancienne passerelle avec un profil (ou `OPENCLAW_STATE_DIR`), et que la nouvelle passerelle en utilise un différent, vous verrez des symptômes comme :

- les changements de configuration ne prennent pas effet
- canaux manquants / déconnectés
- historique de session vide

Correction : exécutez la passerelle/service en utilisant le **même** profil/répertoire d'état que vous avez migré, puis réexécutez :

```bash
openclaw doctor
```

### Piège : copier uniquement `openclaw.json`

`openclaw.json` n'est pas suffisant. De nombreux fournisseurs stockent l'état sous :

- `$OPENCLAW_STATE_DIR/credentials/`
- `$OPENCLAW_STATE_DIR/agents/<agentId>/...`

Migrez toujours le dossier `$OPENCLAW_STATE_DIR` entier.

### Piège : permissions / propriété

Si vous avez copié en tant que root ou changé d'utilisateurs, la passerelle peut échouer à lire les identifiants/sessions.

Correction : assurez-vous que le répertoire d'état + espace de travail appartiennent à l'utilisateur exécutant la passerelle.

### Piège : migrer entre modes distant/local

- Si votre interface (WebUI/TUI) pointe vers une passerelle **distante**, l'hôte distant possède le magasin de session + espace de travail.
- Migrer votre ordinateur portable ne déplacera pas l'état de la passerelle distante.

Si vous êtes en mode distant, migrez l'**hôte de passerelle**.

### Piège : secrets dans les sauvegardes

`$OPENCLAW_STATE_DIR` contient des secrets (clés API, jetons OAuth, identifiants WhatsApp). Traitez les sauvegardes comme des secrets de production :

- stocker chiffré
- éviter de partager sur des canaux non sécurisés
- rotation des clés si vous suspectez une exposition

## Liste de vérification de validation

Sur la nouvelle machine, confirmez :

- `openclaw status` montre la passerelle en cours d'exécution
- Vos canaux sont toujours connectés (par exemple WhatsApp ne nécessite pas de réappairage)
- Le tableau de bord s'ouvre et affiche les sessions existantes
- Vos fichiers d'espace de travail (mémoire, configurations) sont présents

## Connexe

- [Doctor](/fr-FR/gateway/doctor)
- [Dépannage de la passerelle](/fr-FR/gateway/troubleshooting)
- [Où OpenClaw stocke-t-il ses données ?](/fr-FR/help/faq#where-does-openclaw-store-its-data)
