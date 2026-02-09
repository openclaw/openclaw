---
title: "Skapa Skills"
---

# Skapa anpassade Skills 🛠

OpenClaw är utformad för att vara lätt att utöka. "Skickligheter" är det primära sättet att lägga till nya förmågor till din assistent.

## Vad är en Skill?

En skill är en katalog som innehåller en `SKILL.md`-fil (som ger instruktioner och verktygsdefinitioner till LLM:en) och valfritt några skript eller resurser.

## Steg-för-steg: Din första Skill

### 1. Skapa katalog

Färdigheter lever i din arbetsyta, vanligtvis `~/.openclaw/workspace/skills/`. Skapa en ny mapp för din skicklighet:

```bash
mkdir -p ~/.openclaw/workspace/skills/hello-world
```

### 2. Definiera `SKILL.md`

Skapa en 'SKILL.md' fil i den katalogen. Denna fil använder YAML frontmatter för metadata och Markdown för instruktioner.

```markdown
---
name: hello_world
description: A simple skill that says hello.
---

# Hello World Skill

When the user asks for a greeting, use the `echo` tool to say "Hello from your custom skill!".
```

### 3. Lägg till verktyg (valfritt)

Du kan definiera anpassade verktyg i frontmatter eller instruera agenten att använda befintliga systemverktyg (som `bash` eller `browser`).

### 4. Uppdatera OpenClaw

Be din agent att "uppdatera färdigheter" eller starta om porten. OpenClaw kommer att upptäcka den nya katalogen och indexera `SKILL.md`.

## Bästa praxis

- **Var koncis**: Instruera modellen om _vad_ den ska göra, inte hur den ska vara en AI.
- **Säkerhet först**: Om din skill använder `bash`, se till att promptarna inte tillåter godtycklig kommandoinjektion från opålitlig användarinmatning.
- **Testa lokalt**: Använd `openclaw agent --message "use my new skill"` för att testa.

## Delade Skills

Du kan också bläddra bland och bidra med skills till [ClawHub](https://clawhub.com).
