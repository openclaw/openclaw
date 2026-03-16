---
title: "Créer des Compétences"
---

# Créer des Compétences Personnalisées 🛠

OpenClaw est conçu pour être facilement extensible. Les « Compétences » sont le moyen principal d'ajouter de nouvelles capacités à votre assistant.

## Qu'est-ce qu'une Compétence ?

Une compétence est un répertoire contenant un fichier `SKILL.md` (qui fournit des instructions et des définitions d'outils au LLM) et optionnellement des scripts ou des ressources.

## Étape par étape : Votre Première Compétence

### 1. Créer le Répertoire

Les compétences résident dans votre espace de travail, généralement `~/.openclaw/workspace/skills/`. Créez un nouveau dossier pour votre compétence :

```bash
mkdir -p ~/.openclaw/workspace/skills/hello-world
```

### 2. Définir le `SKILL.md`

Créez un fichier `SKILL.md` dans ce répertoire. Ce fichier utilise du frontmatter YAML pour les métadonnées et du Markdown pour les instructions.

```markdown
---
name: hello_world
description: Une compétence simple qui dit bonjour.
---

# Compétence Hello World

Lorsque l'utilisateur demande un salut, utilisez l'outil `echo` pour dire "Bonjour de votre compétence personnalisée !".
```

### 3. Ajouter des Outils (Optionnel)

Vous pouvez définir des outils personnalisés dans le frontmatter ou instruire l'agent d'utiliser des outils système existants (comme `bash` ou `browser`).

### 4. Rafraîchir OpenClaw

Demandez à votre agent de « rafraîchir les compétences » ou redémarrez la passerelle. OpenClaw découvrira le nouveau répertoire et indexera le `SKILL.md`.

## Bonnes Pratiques

- **Soyez Concis** : Indiquez au modèle _quoi_ faire, pas comment être une IA.
- **Sécurité d'Abord** : Si votre compétence utilise `bash`, assurez-vous que les prompts ne permettent pas l'injection de commandes arbitraires à partir d'entrées utilisateur non fiables.
- **Testez Localement** : Utilisez `openclaw agent --message "utilise ma nouvelle compétence"` pour tester.

## Compétences Partagées

Vous pouvez également parcourir et contribuer des compétences sur [ClawHub](https://clawhub.com).
