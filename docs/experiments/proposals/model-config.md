---
summary: "Exploration: model config, auth profiles, and fallback behavior"
read_when:
  - Exploring future model selection + auth profile ideas
title: "Model Config Exploration"
---

# Model Config (Exploration)

This document captures **ideas** for future model configuration. It is not a
shipping spec. For current behavior, see:

- [Models](/concepts/models)
- [Model failover](/concepts/model-failover)
- [OAuth + profiles](/concepts/oauth)

## Motivation

Operators want:

- Multiple auth profiles per provider (personal vs work).
- Simple `/model` selection with predictable fallbacks.
- Clear separation between text models and image-capable models.

## Possible direction (high level)

- Keep model selection simple: `provider/model` with optional aliases.
- Let providers have multiple auth profiles, with an explicit order.
- Use a global fallback list so all sessions fail over consistently.
- Only override image routing when explicitly configured.

## Open questions

- Should profile rotation be per-provider or per-model?
- How should the UI surface profile selection for a session?
- What is the safest migration path from legacy config keys?
