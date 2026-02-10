---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Exploration: model config, auth profiles, and fallback behavior"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Exploring future model selection + auth profile ideas（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Model Config Exploration"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Model Config (Exploration)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This document captures **ideas** for future model configuration. It is not a（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
shipping spec. For current behavior, see:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Models](/concepts/models)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Model failover](/concepts/model-failover)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [OAuth + profiles](/concepts/oauth)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Motivation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Operators want:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Multiple auth profiles per provider (personal vs work).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Simple `/model` selection with predictable fallbacks.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Clear separation between text models and image-capable models.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Possible direction (high level)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Keep model selection simple: `provider/model` with optional aliases.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Let providers have multiple auth profiles, with an explicit order.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Use a global fallback list so all sessions fail over consistently.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Only override image routing when explicitly configured.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Open questions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Should profile rotation be per-provider or per-model?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- How should the UI surface profile selection for a session?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- What is the safest migration path from legacy config keys?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
