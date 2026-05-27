---
summary: "CLI reference for `openclaw memory` (status/index/search)"
read_when:
  - You want to index or search semantic memory
  - You’re debugging memory availability or indexing
title: "memory"
---

# `openclaw memory`

Manage semantic memory indexing and search.
Provided by the active memory plugin (default: `memory-core`; set `plugins.slots.memory = "none"` to disable).

Related:

- Memory concept: [Memory](/concepts/memory)
- Plugins: [Plugins](/tools/plugin)

## Examples

```bash
openclaw memory status
openclaw memory status --deep
openclaw memory index --force
openclaw memory search "meeting notes"
openclaw memory search --query "deployment" --max-results 20
openclaw memory status --json
openclaw memory status --deep --index
openclaw memory status --deep --index --verbose
openclaw memory status --agent main
openclaw memory index --agent main --verbose
```

## Options

`memory status` and `memory index`:

- `--agent <id>`: scope to a single agent. Without it, these commands run for each configured agent; if no agent list is configured, they fall back to the default agent.
- `--verbose`: emit detailed logs during probes and indexing.

`memory status`:

- `--deep`: probe vector + embedding availability.
- `--index`: run a reindex if the store is dirty (implies `--deep`).
- `--json`: print JSON output.

`memory index`:

- `--force`: force a full reindex.

`memory search`:

- Query input: pass either positional `[query]` or `--query <text>`.
- If both are provided, `--query` wins.
- If neither is provided, the command exits with an error.
- `--agent <id>`: scope to a single agent (default: the default agent).
- `--max-results <n>`: limit the number of results returned.
- `--min-score <n>`: filter out low-score matches.
- `--json`: print JSON results.

Notes:

- `memory index --verbose` prints per-phase details (provider, model, sources, batch activity).
- `memory status` includes any extra paths configured via `memorySearch.extraPaths`.
- If effectively active memory remote API key fields are configured as SecretRefs, the command resolves those values from the active gateway snapshot. If gateway is unavailable, the command fails fast.
- Gateway version skew note: this command path requires a gateway that supports `secrets.resolve`; older gateways return an unknown-method error.
