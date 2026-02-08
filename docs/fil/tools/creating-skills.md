---
title: "Paglikha ng Skills"
x-i18n:
  source_path: tools/creating-skills.md
  source_hash: ad801da34fe361ff
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:45:53Z
---

# Paglikha ng Mga Custom na Skills 🛠

Dinisenyo ang OpenClaw para madaling mapalawak. Ang mga "Skills" ang pangunahing paraan para magdagdag ng mga bagong kakayahan sa iyong assistant.

## Ano ang isang Skill?

Ang skill ay isang direktoryo na naglalaman ng isang `SKILL.md` file (na nagbibigay ng mga tagubilin at depinisyon ng tool sa LLM) at opsyonal na ilang script o resource.

## Hakbang-hakbang: Ang Iyong Unang Skill

### 1. Gumawa ng Direktoryo

Ang mga Skill ay nakatira sa iyong workspace, karaniwan ay `~/.openclaw/workspace/skills/`. Gumawa ng bagong folder para sa iyong skill:

```bash
mkdir -p ~/.openclaw/workspace/skills/hello-world
```

### 2. I-define ang `SKILL.md`

Gumawa ng `SKILL.md` file sa direktoryong iyon. Gumagamit ang file na ito ng YAML frontmatter para sa metadata at Markdown para sa mga tagubilin.

```markdown
---
name: hello_world
description: A simple skill that says hello.
---

# Hello World Skill

When the user asks for a greeting, use the `echo` tool to say "Hello from your custom skill!".
```

### 3. Magdagdag ng Mga Tool (Opsyonal)

Maaari kang mag-define ng mga custom na tool sa frontmatter o utusan ang agent na gumamit ng mga umiiral na system tool (gaya ng `bash` o `browser`).

### 4. I-refresh ang OpenClaw

Sabihin sa iyong agent na "refresh skills" o i-restart ang Gateway. Matutuklasan ng OpenClaw ang bagong direktoryo at i-iindex ang `SKILL.md`.

## Mga Best Practice

- **Maging Maikli**: Ituro sa model kung _ano_ ang gagawin, hindi kung paano maging isang AI.
- **Unahin ang Kaligtasan**: Kung gumagamit ang iyong skill ng `bash`, tiyaking hindi pinapayagan ng mga prompt ang arbitrary command injection mula sa hindi pinagkakatiwalaang user input.
- **Mag-test Lokal**: Gamitin ang `openclaw agent --message "use my new skill"` para mag-test.

## Mga Shared na Skill

Maaari ka ring mag-browse at mag-ambag ng mga skill sa [ClawHub](https://clawhub.com).
