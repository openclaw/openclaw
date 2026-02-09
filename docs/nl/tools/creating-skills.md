---
title: "Skills maken"
---

# Aangepaste Skills maken 🛠

OpenClaw is ontworpen om eenvoudig uitbreidbaar te zijn. "Skills" zijn de primaire manier om nieuwe mogelijkheden aan je assistent toe te voegen.

## Wat is een Skill?

Een skill is een directory die een `SKILL.md`-bestand bevat (dat instructies en tooldefinities aan het LLM levert) en optioneel enkele scripts of resources.

## Stap-voor-stap: je eerste Skill

### 1. Maak de directory

Skills bevinden zich in je werkruimte, meestal `~/.openclaw/workspace/skills/`. Maak een nieuwe map voor je skill:

```bash
mkdir -p ~/.openclaw/workspace/skills/hello-world
```

### 2. Definieer de `SKILL.md`

Maak een `SKILL.md`-bestand in die directory. Dit bestand gebruikt YAML-frontmatter voor metadata en Markdown voor instructies.

```markdown
---
name: hello_world
description: A simple skill that says hello.
---

# Hello World Skill

When the user asks for a greeting, use the `echo` tool to say "Hello from your custom skill!".
```

### 3. Tools toevoegen (optioneel)

Je kunt aangepaste tools definiëren in de frontmatter of de agent instrueren om bestaande systeemtools te gebruiken (zoals `bash` of `browser`).

### 4. OpenClaw verversen

Vraag je agent om "refresh skills" of herstart de Gateway. OpenClaw zal de nieuwe directory ontdekken en de `SKILL.md` indexeren.

## Best practices

- **Wees beknopt**: Instrueer het model over _wat_ het moet doen, niet hoe het een AI moet zijn.
- **Veiligheid eerst**: Als je skill `bash` gebruikt, zorg er dan voor dat de prompts geen willekeurige command-injectie toestaan vanuit onbetrouwbare gebruikersinvoer.
- **Lokaal testen**: Gebruik `openclaw agent --message "use my new skill"` om te testen.

## Gedeelde Skills

Je kunt ook skills bekijken en eraan bijdragen op [ClawHub](https://clawhub.com).
