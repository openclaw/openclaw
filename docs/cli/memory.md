---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "CLI reference for `openclaw memory` (status/index/search)"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want to index or search semantic memory（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You’re debugging memory availability or indexing（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "memory"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# `openclaw memory`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Manage semantic memory indexing and search.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Provided by the active memory plugin (default: `memory-core`; set `plugins.slots.memory = "none"` to disable).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Related:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Memory concept: [Memory](/concepts/memory)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Plugins: [Plugins](/tools/plugin)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Examples（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw memory status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw memory status --deep（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw memory status --deep --index（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw memory status --deep --index --verbose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw memory index（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw memory index --verbose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw memory search "release checklist"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw memory status --agent main（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw memory index --agent main --verbose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Options（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Common:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--agent <id>`: scope to a single agent (default: all configured agents).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--verbose`: emit detailed logs during probes and indexing.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `memory status --deep` probes vector + embedding availability.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `memory status --deep --index` runs a reindex if the store is dirty.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `memory index --verbose` prints per-phase details (provider, model, sources, batch activity).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `memory status` includes any extra paths configured via `memorySearch.extraPaths`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
