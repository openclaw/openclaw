---
title: "Referencia de configuración"
summary: "Referencia para la configuración del gateway"
---

# Referencia de configuración

## Agent Defaults

### `agents.defaults.systemPromptSuffix`

Texto agregado al prompt del sistema en cada turno de conversación. Como se inyecta desde la configuración (no desde el historial de conversación), **sobrevive a la compactación** — ideal para reglas de comportamiento persistentes, restricciones o identidad que nunca deben perderse durante sesiones largas.

El sufijo se agrega _después_ de cualquier `extraSystemPrompt` existente (por ej. de la configuración del canal o el contexto de un subagente), por lo que nunca reemplaza otras fuentes del prompt del sistema.

> **Note:** For CLI providers, the suffix behavior depends on the backend: `claude-cli` receives the suffix on the first turn only (session state is maintained internally). `codex-cli` does not support system prompt injection and will not receive the suffix. Embedded providers (the default, used by ~99% of configurations) receive the suffix on every turn.

```json5
{
  agents: {
    defaults: {
      systemPromptSuffix: "Respondé siempre en español. No hagas commits en repositorios públicos sin aprobación explícita.",
    },
  },
}
```
