---
title: "Konfigurationsreferenz"
summary: "Referenz für die Gateway-Konfiguration"
---

# Konfigurationsreferenz

## Agent Defaults

### `agents.defaults.systemPromptSuffix`

Text, der bei jedem Gesprächszug an den System-Prompt angehängt wird. Da er aus der Konfiguration injiziert wird (nicht aus dem Gesprächsverlauf), **überlebt er die Komprimierung** — ideal für persistente Verhaltensregeln, Einschränkungen oder Identitäten, die während langer Sitzungen niemals verloren gehen dürfen.

Das Suffix wird _nach_ einem vorhandenen `extraSystemPrompt` (z. B. aus der Kanal-Konfiguration oder dem Subagenten-Kontext) angehängt und ersetzt daher keine anderen System-Prompt-Quellen.

> **Note:** For CLI providers, the suffix behavior depends on the backend: `claude-cli` receives the suffix on the first turn only (session state is maintained internally). `codex-cli` does not support system prompt injection and will not receive the suffix. Embedded providers (the default, used by ~99% of configurations) receive the suffix on every turn.

```json5
{
  agents: {
    defaults: {
      systemPromptSuffix: "Antworte immer auf Deutsch. Keine Commits in öffentliche Repos ohne ausdrückliche Genehmigung.",
    },
  },
}
```
