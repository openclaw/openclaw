---
title: "Riferimento configurazione"
summary: "Riferimento per la configurazione del gateway"
---

# Riferimento configurazione

## Agent Defaults

### `agents.defaults.systemPromptSuffix`

Testo aggiunto al prompt di sistema ad ogni turno di conversazione. Poiché viene iniettato dalla configurazione (non dalla cronologia della conversazione), **sopravvive alla compattazione** — ideale per regole comportamentali persistenti, vincoli o identità che non devono mai andare persi durante sessioni lunghe.

Il suffisso viene aggiunto _dopo_ qualsiasi `extraSystemPrompt` esistente (ad es. dalla configurazione del canale o dal contesto del sotto-agente), quindi non sostituisce altre fonti del prompt di sistema.

> **Note:** For CLI providers, the suffix behavior depends on the backend: `claude-cli` receives the suffix on the first turn only (session state is maintained internally). `codex-cli` does not support system prompt injection and will not receive the suffix. Embedded providers (the default, used by ~99% of configurations) receive the suffix on every turn.

```json5
{
  agents: {
    defaults: {
      systemPromptSuffix: "Rispondi sempre in italiano. Non eseguire commit su repository pubblici senza approvazione esplicita.",
    },
  },
}
```
