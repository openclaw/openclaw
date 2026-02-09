---
title: "Oprettelse af Skills"
---

# Oprettelse af brugerdefinerede Skills 🛠

OpenClaw er designet til at være let udvidet. "Færdigheder" er den primære måde at tilføje nye funktioner til din assistent.

## Hvad er en Skill?

En skill er en mappe, der indeholder en `SKILL.md`-fil (som giver instruktioner og værktøjsdefinitioner til LLM’en) og eventuelt nogle scripts eller ressourcer.

## Trin for trin: Din første Skill

### 1. Opret mappen

Færdigheder lever i dit arbejdsområde, normalt `~/.openclaw/workspace/skills/`. Opret en ny mappe til din færdighed:

```bash
mkdir -p ~/.openclaw/workspace/skills/hello-world
```

### 2. Definér 'SKILL.md'

Opret en `SKILL.md` fil i mappen. Denne fil bruger YAML frontmatter til metadata og Markdown til instruktioner.

```markdown
---
name: hello_world
description: A simple skill that says hello.
---

# Hello World Skill

When the user asks for a greeting, use the `echo` tool to say "Hello from your custom skill!".
```

### 3. Tilføj Værktøjer (Valgfri)

Du kan definere brugerdefinerede værktøjer i frontmatter eller instruere agenten i at bruge eksisterende systemværktøjer (som `bash` eller `browser`).

### 4. Genopfrisk OpenClaw

Bed din agent om at "genopfriske færdigheder" eller genstarte gatewayen. OpenClaw vil opdage den nye mappe og indeksere `SKILL.md`.

## Best Practices

- **Vær kortfattet**: Instruér modellen i _hvad_ den skal gøre, ikke hvordan man er en AI.
- **Sikkerhed først**: Hvis din skill bruger `bash`, skal du sikre, at prompts ikke tillader vilkårlig kommandoinjektion fra utroværdigt brugerinput.
- **Test lokalt**: Brug `openclaw agent --message "use my new skill"` til at teste.

## Delte Skills

Du kan også gennemse og bidrage med skills på [ClawHub](https://clawhub.com).
