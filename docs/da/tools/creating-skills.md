---
title: "Oprettelse af Skills"
x-i18n:
  source_path: tools/creating-skills.md
  source_hash: ad801da34fe361ff
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:39Z
---

# Oprettelse af brugerdefinerede Skills 🛠

OpenClaw er designet til at være let at udvide. "Skills" er den primære måde at tilføje nye funktioner til din assistent.

## Hvad er en Skill?

En skill er en mappe, der indeholder en `SKILL.md`-fil (som giver instruktioner og værktøjsdefinitioner til LLM’en) og eventuelt nogle scripts eller ressourcer.

## Trin for trin: Din første Skill

### 1. Opret mappen

Skills ligger i dit workspace, typisk `~/.openclaw/workspace/skills/`. Opret en ny mappe til din skill:

```bash
mkdir -p ~/.openclaw/workspace/skills/hello-world
```

### 2. Definér `SKILL.md`

Opret en `SKILL.md`-fil i mappen. Denne fil bruger YAML-frontmatter til metadata og Markdown til instruktioner.

```markdown
---
name: hello_world
description: A simple skill that says hello.
---

# Hello World Skill

When the user asks for a greeting, use the `echo` tool to say "Hello from your custom skill!".
```

### 3. Tilføj værktøjer (valgfrit)

Du kan definere brugerdefinerede værktøjer i frontmatter eller instruere agenten i at bruge eksisterende systemværktøjer (som `bash` eller `browser`).

### 4. Opdatér OpenClaw

Bed din agent om at "refresh skills" eller genstart gateway. OpenClaw vil finde den nye mappe og indeksere `SKILL.md`.

## Best Practices

- **Vær kortfattet**: Instruér modellen i _hvad_ den skal gøre, ikke hvordan man er en AI.
- **Sikkerhed først**: Hvis din skill bruger `bash`, skal du sikre, at prompts ikke tillader vilkårlig kommandoinjektion fra utroværdigt brugerinput.
- **Test lokalt**: Brug `openclaw agent --message "use my new skill"` til at teste.

## Delte Skills

Du kan også gennemse og bidrage med skills på [ClawHub](https://clawhub.com).
