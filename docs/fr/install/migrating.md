---
summary: "Deplacer (migrer) une installation OpenClaw d'une machine a une autre"
read_when:
  - Vous deplacez OpenClaw vers un nouvel ordinateur portable/serveur
  - Vous souhaitez conserver les sessions, l'authentification et les connexions aux canaux (WhatsApp, etc.)
title: "Guide de migration"
---

# Migration d’OpenClaw vers une nouvelle machine

Ce guide permet de migrer une Gateway (passerelle) OpenClaw d’une machine a une autre **sans refaire la prise en main**.

Conceptuellement, la migration est simple :

- Copier le **repertoire d’etat** (`$OPENCLAW_STATE_DIR`, par defaut : `~/.openclaw/`) — il inclut la configuration, l’authentification, les sessions et l’etat des canaux.
- Copier votre **espace de travail** (`~/.openclaw/workspace/` par defaut) — il inclut vos fichiers d’agent (memoire, invites, etc.).

Mais il existe des pieges frequents autour des **profils**, des **permissions** et des **copies partielles**.

## Avant de commencer (ce que vous migrez)

### 1. Identifier votre repertoire d’etat

La plupart des installations utilisent la valeur par defaut :

- **Repertoire d’etat :** `~/.openclaw/`

Mais cela peut etre different si vous utilisez :

- `--profile <name>` (devient souvent `~/.openclaw-<profile>/`)
- `OPENCLAW_STATE_DIR=/some/path`

Si vous n’etes pas sur, executez sur l’ancienne machine :

```bash
openclaw status
```

Recherchez les mentions de `OPENCLAW_STATE_DIR` / profile dans la sortie. Si vous executez plusieurs passerelles, repetez pour chaque profil.

### 2. Identifier votre espace de travail

Valeurs par défaut:

- `~/.openclaw/workspace/` (espace de travail recommande)
- un dossier personnalise que vous avez cree

Votre espace de travail est l’endroit ou se trouvent des fichiers comme `MEMORY.md`, `USER.md` et `memory/*.md`.

### 3. Comprendre ce que vous conserverez

Si vous copiez **a la fois** le repertoire d’etat et l’espace de travail, vous conservez :

- La configuration de la Gateway (`openclaw.json`)
- Les profils d’authentification / cles API / jetons OAuth
- L’historique des sessions + l’etat de l’agent
- L’etat des canaux (par ex. connexion/session WhatsApp)
- Vos fichiers d’espace de travail (memoire, notes de Skills, etc.)

Si vous copiez **uniquement** l’espace de travail (par ex. via Git), vous **ne** conservez **pas** :

- les sessions
- les identifiants
- les connexions aux canaux

Ceux-ci se trouvent sous `$OPENCLAW_STATE_DIR`.

## Etapes de migration (recommandees)

### Etape 0 — Effectuer une sauvegarde (ancienne machine)

Sur l’**ancienne** machine, arrete d’abord la passerelle afin que les fichiers ne changent pas pendant la copie :

```bash
openclaw gateway stop
```

(Facultatif mais recommande) archivez le repertoire d’etat et l’espace de travail :

```bash
# Adjust paths if you use a profile or custom locations
cd ~
tar -czf openclaw-state.tgz .openclaw

tar -czf openclaw-workspace.tgz .openclaw/workspace
```

Si vous avez plusieurs profils/repertoires d’etat (par ex. `~/.openclaw-main`, `~/.openclaw-work`), archivez chacun.

### Etape 1 — Installer OpenClaw sur la nouvelle machine

Sur la **nouvelle** machine, installez la CLI (et Node si necessaire) :

- Voir : [Install](/install)

A ce stade, il est acceptable que la prise en main cree un nouveau `~/.openclaw/` — vous l’ecraserez a l’etape suivante.

### Etape 2 — Copier le repertoire d’etat + l’espace de travail sur la nouvelle machine

Copiez **les deux** :

- `$OPENCLAW_STATE_DIR` (par defaut `~/.openclaw/`)
- votre espace de travail (par defaut `~/.openclaw/workspace/`)

Approches courantes :

- `scp` les archives tar puis extraire
- `rsync -a` via SSH
- disque externe

Apres la copie, assurez-vous que :

- Les repertoires caches ont ete inclus (par ex. `.openclaw/`)
- Le proprietaire des fichiers est correct pour l’utilisateur qui execute la passerelle

### Etape 3 — Executer Doctor (migrations + reparation des services)

Sur la **nouvelle** machine :

```bash
openclaw doctor
```

Doctor est la commande « sure et sans surprise ». Elle repare les services, applique les migrations de configuration et avertit en cas d’incoherences.

Puis :

```bash
openclaw gateway restart
openclaw status
```

## Pieges courants (et comment les eviter)

### Piege : decalage de profil / repertoire d’etat

Si vous executiez l’ancienne passerelle avec un profil (ou `OPENCLAW_STATE_DIR`), et que la nouvelle passerelle en utilise un different, vous observerez des symptomes tels que :

- les modifications de configuration ne prennent pas effet
- des canaux manquants / deconnectes
- un historique de session vide

Correctif : executez la passerelle/le service en utilisant **le meme** profil/repertoire d’etat que vous avez migre, puis relancez :

```bash
openclaw doctor
```

### Piege : ne copier que `openclaw.json`

`openclaw.json` ne suffit pas. De nombreux fournisseurs stockent l’etat sous :

- `$OPENCLAW_STATE_DIR/credentials/`
- `$OPENCLAW_STATE_DIR/agents/<agentId>/...`

Migrez toujours l’integralite du dossier `$OPENCLAW_STATE_DIR`.

### Piege : permissions / proprietaire

Si vous avez copie en tant que root ou change d’utilisateur, la passerelle peut ne pas parvenir a lire les identifiants/sessions.

Correctif : assurez-vous que le repertoire d’etat et l’espace de travail appartiennent a l’utilisateur qui execute la passerelle.

### Piege : migration entre modes distant/local

- Si votre interface (WebUI/TUI) pointe vers une passerelle **distante**, l’hote distant possede le stockage des sessions et l’espace de travail.
- Migrer votre ordinateur portable ne deplacera pas l’etat de la passerelle distante.

Si vous êtes en mode distant, migrez l'**hôte de passerelle**.

### Piege : secrets dans les sauvegardes

`$OPENCLAW_STATE_DIR` contient des secrets (cles API, jetons OAuth, identifiants WhatsApp). Traitez les sauvegardes comme des secrets de production :

- stockage chiffré
- evitez le partage via des canaux non securises
- faire pivoter les touches si vous soupçonnez l'exposition

## Liste de verification

Sur la nouvelle machine, verifiez :

- `openclaw status` indique que la passerelle est en cours d’execution
- Vos canaux sont toujours connectes (par ex. WhatsApp ne necessite pas de nouvel appairage)
- Le tableau de bord s’ouvre et affiche les sessions existantes
- Vos fichiers d’espace de travail (memoire, configurations) sont presents

## Associe

- [Doctor](/gateway/doctor)
- [Depannage de la Gateway](/gateway/troubleshooting)
- [Ou OpenClaw stocke-t-il ses donnees ?](/help/faq#where-does-openclaw-store-its-data)
