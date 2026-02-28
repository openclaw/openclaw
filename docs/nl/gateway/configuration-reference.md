---
title: "Configuratiereferentie"
summary: "Referentie voor de gateway-configuratie"
---

# Configuratiereferentie

## Agent Defaults

### `agents.defaults.systemPromptSuffix`

Tekst die bij elke gespreksbeurt aan de systeemprompt wordt toegevoegd. Omdat het vanuit de configuratie wordt geïnjecteerd (niet vanuit de gespreksgeschiedenis), **overleeft het compactie** — ideaal voor persistente gedragsregels, beperkingen of identiteit die tijdens lange sessies nooit verloren mogen gaan.

Het achtervoegsel wordt _na_ een bestaande `extraSystemPrompt` (bijv. van kanaalconfiguratie of subagent-context) toegevoegd en vervangt dus geen andere systeemprompt-bronnen.

> **Note:** For CLI providers, the suffix behavior depends on the backend: `claude-cli` receives the suffix on the first turn only (session state is maintained internally). `codex-cli` does not support system prompt injection and will not receive the suffix. Embedded providers (the default, used by ~99% of configurations) receive the suffix on every turn.

```json5
{
  agents: {
    defaults: {
      systemPromptSuffix: "Antwoord altijd in het Nederlands. Geen commits naar publieke repo's zonder uitdrukkelijke toestemming.",
    },
  },
}
```
