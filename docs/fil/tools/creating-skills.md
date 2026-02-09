---
title: "Paglikha ng Skills"
---

# Paglikha ng Mga Custom na Skills 🛠

OpenClaw is designed to be easily extensible. "Skills" are the primary way to add new capabilities to your assistant.

## Ano ang isang Skill?

Ang skill ay isang direktoryo na naglalaman ng isang `SKILL.md` file (na nagbibigay ng mga tagubilin at depinisyon ng tool sa LLM) at opsyonal na ilang script o resource.

## Hakbang-hakbang: Ang Iyong Unang Skill

### 38. 1. 39. Likhain ang Direktoryo

40. Ang mga skill ay nasa iyong workspace, karaniwan sa `~/.openclaw/workspace/skills/`. Create a new folder for your skill:

```bash
mkdir -p ~/.openclaw/workspace/skills/hello-world
```

### 2. Define the `SKILL.md`

41. Gumawa ng `SKILL.md` file sa direktoryong iyon. This file uses YAML frontmatter for metadata and Markdown for instructions.

```markdown
---
name: hello_world
description: A simple skill that says hello.
---

# Hello World Skill

When the user asks for a greeting, use the `echo` tool to say "Hello from your custom skill!".
```

### 3. Add Tools (Optional)

Maaari kang mag-define ng mga custom na tool sa frontmatter o utusan ang agent na gumamit ng mga umiiral na system tool (gaya ng `bash` o `browser`).

### 42. 4. 43. I-refresh ang OpenClaw

44. Sabihin sa iyong agent na "refresh skills" o i-restart ang gateway. 45. Matutuklasan ng OpenClaw ang bagong direktoryo at i-iindex ang `SKILL.md`.

## Mga Best Practice

- **Maging Maikli**: Ituro sa model kung _ano_ ang gagawin, hindi kung paano maging isang AI.
- **Unahin ang Kaligtasan**: Kung gumagamit ang iyong skill ng `bash`, tiyaking hindi pinapayagan ng mga prompt ang arbitrary command injection mula sa hindi pinagkakatiwalaang user input.
- **Mag-test Lokal**: Gamitin ang `openclaw agent --message "use my new skill"` para mag-test.

## Mga Shared na Skill

Maaari ka ring mag-browse at mag-ambag ng mga skill sa [ClawHub](https://clawhub.com).
