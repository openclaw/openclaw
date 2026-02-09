---
summary: "CLI-reference for `openclaw configure` (interaktive konfigurationsprompter)"
read_when:
  - Du vil justere legitimationsoplysninger, enheder eller agentstandarder interaktivt
title: "configure"
---

# `openclaw configure`

Interaktiv prompt til at opsætte legitimationsoplysninger, enheder og agentstandarder.

Bemærk: Afsnittet **Model** indeholder nu et multivalg for
`agents.defaults.models`-tilladelseslisten (det, der vises i `/model` og modelvælgeren).

Tip: `openclaw config` uden en underkommando åbner den samme guide. Benyt
`openclaw config getřset- unset` til ikke-interaktive redigeringer.

Relateret:

- Gateway-konfigurationsreference: [Konfiguration](/gateway/configuration)
- Config CLI: [Config](/cli/config)

Noter:

- Vælg hvor Gateway kører altid opdaterer `gateway.mode`. Du kan vælge "Fortsæt" uden andre sektioner, hvis det er alt hvad du behøver.
- Kanal-orienterede tjenester (Slack/Discord/Matrix/Microsoft Teams) prompt til kanal/rum tilladelser under opsætning. Du kan indtaste navne eller ID'er; guiden løser navne til ID'er når det er muligt.

## Eksempler

```bash
openclaw configure
openclaw configure --section models --section channels
```
