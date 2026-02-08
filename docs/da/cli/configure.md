---
summary: "CLI-reference for `openclaw configure` (interaktive konfigurationsprompter)"
read_when:
  - Du vil justere legitimationsoplysninger, enheder eller agentstandarder interaktivt
title: "configure"
x-i18n:
  source_path: cli/configure.md
  source_hash: 9cb2bb5237b02b3a
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:02Z
---

# `openclaw configure`

Interaktiv prompt til at opsætte legitimationsoplysninger, enheder og agentstandarder.

Bemærk: Afsnittet **Model** indeholder nu et multivalg for
`agents.defaults.models`-tilladelseslisten (det, der vises i `/model` og modelvælgeren).

Tip: `openclaw config` uden en underkommando åbner den samme opsætningsguide. Brug
`openclaw config get|set|unset` til ikke-interaktive ændringer.

Relateret:

- Gateway-konfigurationsreference: [Konfiguration](/gateway/configuration)
- Config CLI: [Config](/cli/config)

Noter:

- Valg af, hvor Gateway kører, opdaterer altid `gateway.mode`. Du kan vælge "Fortsæt" uden andre afsnit, hvis det er alt, hvad du har brug for.
- Kanalorienterede tjenester (Slack/Discord/Matrix/Microsoft Teams) beder om kanal-/rum-tilladelseslister under opsætningen. Du kan angive navne eller ID’er; guiden oversætter navne til ID’er, når det er muligt.

## Eksempler

```bash
openclaw configure
openclaw configure --section models --section channels
```
