---
summary: "Brug OpenCode Zen (kuraterede modeller) med OpenClaw"
read_when:
  - Du vil have OpenCode Zen til modeladgang
  - Du vil have en kurateret liste over kodevenlige modeller
title: "OpenCode Zen"
---

# OpenCode Zen

OpenCode Zen er en \*\* kurateret liste over modeller\*\* anbefalet af OpenCode teamet for kodning agenter.
Det er en valgfri, hosted model adgang sti, der bruger en API-nøgle og `opencode` udbyder.
Zen er i øjeblikket i beta.

## CLI-opsætning

```bash
openclaw onboard --auth-choice opencode-zen
# or non-interactive
openclaw onboard --opencode-zen-api-key "$OPENCODE_API_KEY"
```

## Konfigurationsudsnit

```json5
{
  env: { OPENCODE_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "opencode/claude-opus-4-6" } } },
}
```

## Noter

- `OPENCODE_ZEN_API_KEY` understøttes også.
- Du logger ind på Zen, tilføjer betalingsoplysninger og kopierer din API-nøgle.
- OpenCode Zen fakturerer pr. anmodning; se OpenCode-dashboardet for detaljer.
