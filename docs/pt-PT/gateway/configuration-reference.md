---
title: "Referência de configuração"
summary: "Referência para a configuração do gateway"
---

# Referência de configuração

## Agent Defaults

### `agents.defaults.systemPromptSuffix`

Texto adicionado ao prompt de sistema em cada turno de conversa. Como é injetado a partir da configuração (não do histórico de conversa), **sobrevive à compactação** — ideal para regras de comportamento persistentes, restrições ou identidade que nunca devem ser perdidas durante sessões longas.

O sufixo é adicionado _após_ qualquer `extraSystemPrompt` existente (por ex. da configuração do canal ou do contexto de um subagente), portanto nunca substitui outras fontes do prompt de sistema.

> **Note:** For CLI providers, the suffix behavior depends on the backend: `claude-cli` receives the suffix on the first turn only (session state is maintained internally). `codex-cli` does not support system prompt injection and will not receive the suffix. Embedded providers (the default, used by ~99% of configurations) receive the suffix on every turn.

```json5
{
  agents: {
    defaults: {
      systemPromptSuffix: "Responda sempre em português. Nunca faça commits em repositórios públicos sem aprovação explícita.",
    },
  },
}
```
