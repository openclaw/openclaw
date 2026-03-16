---
summary: "Guide ClawHub : registry skills public + workflows CLI"
read_when:
  - Introduction ClawHub vers nouveaux users
  - Installation, recherche ou publication skills
  - Explication flags CLI ClawHub et comportement sync
title: "ClawHub"
---

# ClawHub

ClawHub est **registry skill public pour OpenClaw**. Service gratuit : tous skills publics, ouverts et visibles à tous pour partage et réutilisation. Skill juste dossier avec fichier `SKILL.md` (plus fichiers texte support). Vous pouvez parcourir skills dans app web ou utiliser CLI pour rechercher, installer, mettre à jour et publier skills.

Site : [clawhub.ai](https://clawhub.ai)

## Qu'est ClawHub

- Registry public pour skills OpenClaw.
- Store versionné bundles skill et metadata.
- Surface discovery pour recherche, tags et signaux usage.

## Comment ça marche

1. User publie bundle skill (fichiers + metadata).
2. ClawHub stocke bundle, parse metadata et assigne version.
3. Registry indexe skill pour recherche et discovery.
4. Users parcourent, téléchargent et installent skills dans OpenClaw.

## Que pouvez-vous faire

- Publier nouveaux skills et nouvelles versions skills existants.
- Découvrir skills par nom, tags ou recherche.
- Télécharger bundles skill et inspecter leurs fichiers.
- Signaler skills abusifs ou unsafe.
- Si vous êtes modérateur, masquer, démasquer, supprimer ou ban.

## Pour qui (beginner-friendly)

Si vous voulez ajouter nouvelles capacités à votre agent OpenClaw, ClawHub façon plus facile trouver et installer skills. Vous n'avez pas besoin savoir comment backend marche. Vous pouvez :

- Rechercher skills en langage plain.
- Installer skill dans votre workspace.
- Mettre à jour skills plus tard avec une commande.
- Backup vos propres skills en publiant.

## Quick start (non-technique)

1. Installer CLI (voir section suivante).
2. Rechercher quelque chose dont vous avez besoin :
   - `clawhub search "calendar"`
3. Installer skill :
   - `clawhub install <skill-slug>`
4. Démarrer nouvelle session OpenClaw pour pickup nouveau skill.

## Installer CLI

Choisir un :

```bash
npm i -g clawhub
```

```bash
pnpm add -g clawhub
```

## Comment ça fit dans OpenClaw

Par défaut, CLI installe skills dans `./skills` sous répertoire travail actuel. Si workspace OpenClaw configuré, `clawhub` fallback vers workspace sauf override `--workdir` (ou `CLAWHUB_WORKDIR`). OpenClaw charge workspace skills depuis `<workspace>/skills` et les pickupera dans **prochaine** session. Si vous utilisez déjà `~/.openclaw/skills` ou bundled skills, workspace skills prennent précédence.

Pour plus détail comment skills chargés, partagés et gated, voir [Skills](/fr-FR/tools/skills).

## Overview système skill

Skill est bundle versionné fichiers qui enseigne OpenClaw comment performer tâche spécifique. Chaque publish crée nouvelle version, et registry garde historique versions pour users auditer changements.

Skill typique inclut :

- `SKILL.md` : instructions pour agent
- Fichiers support (scripts, configs, data)
- Metadata (`package.json` ou frontmatter)

## Commandes CLI

### Recherche

```bash
# Recherche basique
clawhub search "web scraping"

# Recherche avec tags
clawhub search --tags automation,data

# Recherche avec limit
clawhub search "calendar" --limit 10
```

### Install

```bash
# Installer dernière version
clawhub install my-skill

# Installer version spécifique
clawhub install my-skill@1.2.0

# Installer dans répertoire custom
clawhub install my-skill --workdir ~/custom/skills
```

### Mettre à jour

```bash
# Mettre à jour tous skills
clawhub update

# Mettre à jour skill spécifique
clawhub update my-skill

# Voir updates disponibles
clawhub outdated
```

### Publier

```bash
# Publier skill depuis répertoire actuel
clawhub publish

# Publier avec message version
clawhub publish --message "Ajout support nouvelle API"

# Publier depuis path spécifique
clawhub publish ./skills/my-skill
```

### Lister

```bash
# Lister skills installés
clawhub list

# Lister avec détails
clawhub list --verbose

# Lister skills outdated
clawhub outdated
```

## Structure Skill

Skill minimal :

```
my-skill/
├── SKILL.md          # Instructions agent
└── package.json      # Metadata
```

Skill complet :

```
my-skill/
├── SKILL.md
├── package.json
├── scripts/
│   ├── setup.sh
│   └── run.js
├── data/
│   └── config.json
└── README.md
```

## Metadata Skill

`package.json` exemple :

```json
{
  "name": "my-skill",
  "version": "1.0.0",
  "description": "Description courte skill",
  "keywords": ["automation", "api"],
  "openclaw": {
    "minVersion": "2024.1.0",
    "maxVersion": "2025.*",
    "permissions": ["network", "exec"]
  }
}
```

Frontmatter `SKILL.md` :

```yaml
---
name: my-skill
version: 1.0.0
tags: [automation, api]
requires:
  - openclaw: ">=2024.1.0"
  - node: ">=18"
---
```

## Publication Workflow

1. **Créer** skill dans workspace local
2. **Tester** skill avec OpenClaw
3. **Préparer** metadata (`package.json`, tags)
4. **Publier** via `clawhub publish`
5. **Vérifier** sur clawhub.ai

## Versioning

ClawHub utilise semver :

- **Major** (1.0.0 → 2.0.0) : breaking changes
- **Minor** (1.0.0 → 1.1.0) : nouvelles features, compatible backward
- **Patch** (1.0.0 → 1.0.1) : bugfixes

```bash
# Publier patch
clawhub publish --patch

# Publier minor
clawhub publish --minor

# Publier major
clawhub publish --major
```

## Sécurité

**ClawHub review :**

- Skills publics visibles à tous
- Modération communautaire
- Signalement skills problématiques

**Best practices :**

- Reviewer code skill avant install
- Vérifier réputation auteur
- Tester dans sandbox d'abord
- Signaler skills suspects

## Variables Environnement

```bash
# Répertoire install custom
export CLAWHUB_WORKDIR=~/my-skills

# API endpoint custom (développement)
export CLAWHUB_API_URL=http://localhost:3000

# Token auth (pour publish)
export CLAWHUB_TOKEN=your-token
```

## Troubleshooting

**Install échoue :**

```bash
# Vérifier connection
clawhub ping

# Retry avec verbose
clawhub install my-skill --verbose

# Clear cache
clawhub cache clear
```

**Publish échoue :**

```bash
# Vérifier auth
clawhub whoami

# Login
clawhub login

# Verify metadata
clawhub validate
```

**Skill pas chargé :**

```bash
# Vérifier installation
clawhub list

# Vérifier workspace OpenClaw
openclaw config get workspace

# Restart session OpenClaw
openclaw reset
```

## Exemples Skills

**Skill automation basique :**

```markdown
# SKILL.md

Ce skill automatise tâches répétitives.

## Usage

Demandez "automatise cette tâche" et je vais...

## Capacités

- Détection pattern automatique
- Génération script
- Execution sûre
```

**Skill intégration API :**

```markdown
# SKILL.md

Skill intégration API ServiceX.

## Setup

1. Obtenez API key depuis servicex.com
2. Configurez : `export SERVICEX_API_KEY=...`

## Usage

"Requête ServiceX pour..."
```

Voir aussi :

- [Skills](/fr-FR/tools/skills)
- [Créer Skills](/fr-FR/tools/creating-skills)
- [Config Skills](/fr-FR/tools/skills-config)
