---
title: "Creer des Skills"
---

# Creer des Skills personnalises 🛠

OpenClaw est concu pour etre facilement extensible. Les « Skills » sont le moyen principal d’ajouter de nouvelles fonctionnalites a votre assistant.

## Qu’est-ce qu’un Skill ?

Un skill est un repertoire contenant un fichier `SKILL.md` (qui fournit des instructions et des definitions d’outils au LLM) et, optionnellement, des scripts ou des ressources.

## Etape par etape : votre premier Skill

### 1. Creer le repertoire

Les Skills se trouvent dans votre espace de travail, generalement `~/.openclaw/workspace/skills/`. Creez un nouveau dossier pour votre skill :

```bash
mkdir -p ~/.openclaw/workspace/skills/hello-world
```

### 2. Definir le `SKILL.md`

Creez un fichier `SKILL.md` dans ce repertoire. Ce fichier utilise un frontmatter YAML pour les metadonnees et Markdown pour les instructions.

```markdown
---
name: hello_world
description: A simple skill that says hello.
---

# Hello World Skill

When the user asks for a greeting, use the `echo` tool to say "Hello from your custom skill!".
```

### 3. Ajouter des outils (optionnel)

Vous pouvez definir des outils personnalises dans le frontmatter ou demander a l’agent d’utiliser des outils systeme existants (comme `bash` ou `browser`).

### 4. Actualiser OpenClaw

Demandez a votre agent de « rafraichir les Skills » ou redemarrez la Gateway (passerelle). OpenClaw decouvrira le nouveau repertoire et indexera le `SKILL.md`.

## Bonnes pratiques

- **Soyez concis** : Indiquez au modele _quoi_ faire, pas comment etre une IA.
- **La securite avant tout** : Si votre skill utilise `bash`, assurez-vous que les invites ne permettent pas l’injection de commandes arbitraires a partir d’entrees utilisateur non fiables.
- **Tester en local** : Utilisez `openclaw agent --message "use my new skill"` pour tester.

## Skills partages

Vous pouvez egalement parcourir et contribuer a des skills sur [ClawHub](https://clawhub.com).
