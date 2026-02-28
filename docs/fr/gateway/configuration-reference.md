---
title: "Référence de configuration"
summary: "Référence pour la configuration du gateway"
---

# Référence de configuration

## Agent Defaults

### `agents.defaults.systemPromptSuffix`

Texte ajouté au prompt système à chaque tour de conversation. Comme il est injecté depuis la configuration (et non depuis l'historique de conversation), il **survit à la compaction** — idéal pour les règles de comportement persistantes, les contraintes ou l'identité qui ne doivent jamais être perdues pendant les longues sessions.

Le suffixe est ajouté _après_ tout `extraSystemPrompt` existant (par ex. depuis la configuration du canal ou le contexte d'un sous-agent), il ne remplace donc aucune autre source de prompt système.

> **Note:** For CLI providers, the suffix behavior depends on the backend: `claude-cli` receives the suffix on the first turn only (session state is maintained internally). `codex-cli` does not support system prompt injection and will not receive the suffix. Embedded providers (the default, used by ~99% of configurations) receive the suffix on every turn.

```json5
{
  agents: {
    defaults: {
      systemPromptSuffix: "Répondez toujours en français. Ne commitez jamais sur des repos publics sans approbation explicite.",
    },
  },
}
```
