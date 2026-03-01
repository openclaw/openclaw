# OpenClaw Qdrant + Embedding Sidecar Integration

This repository integration adds a **non-breaking sidecar** for memory indexing/search using Qdrant and OpenAI-compatible embeddings.

## Safety
- No API key is committed.
- Runtime secret file is ignored by git.
- Core OpenClaw native memory remains available.

## Added scripts
- `scripts/qdrant-memory-index.mjs`
- `scripts/qdrant-memory-index-if-due.sh`
- `scripts/qdrant-memory-run-from-env.sh`
- `scripts/qdrant-memory-query.mjs`
- `scripts/qdrant-memory-context.sh`
- `qdrant-setup/projects.example.json`

## Env setup
1. Copy template:
```bash
cp qdrant-setup/qdrant-memory.env.example qdrant-setup/qdrant-memory.env
```
2. Fill values in `qdrant-setup/qdrant-memory.env`:
- `OPENCLAW_QDRANT_MEMORY_ENABLED=true`
- `OPENCLAW_QDRANT_URL=http://127.0.0.1:6333`
- `OPENCLAW_QDRANT_EMBEDDING_API_URL=<your endpoint>`
- `OPENCLAW_QDRANT_EMBEDDING_API_KEY=<your key>`
- `OPENCLAW_QDRANT_EMBEDDING_MODEL=<your model>`
- `OPENCLAW_QDRANT_EMBEDDING_DIM=<vector dimension>`

Optional codebase indexing:
- `OPENCLAW_QDRANT_CODE_INDEX_ENABLED=true`
- Copy projects template:
```bash
cp qdrant-setup/projects.example.json qdrant-setup/projects.json
```
- Edit `qdrant-setup/projects.json` with your project paths.

## Manual operations
### Index now
```bash
scripts/qdrant-memory-run-from-env.sh
```

### Semantic query
```bash
set -a; source qdrant-setup/qdrant-memory.env; set +a
scripts/qdrant-memory-query.mjs --limit 5 "appbuilder build success"
```

### Semantic query scoped to one project
```bash
set -a; source qdrant-setup/qdrant-memory.env; set +a
scripts/qdrant-memory-query.mjs --kind code --project app-builder --limit 5 "build pipeline"
```

### Context retrieval (policy-aware)
```bash
scripts/qdrant-memory-context.sh "appbuilder build success"
```

## Reversible retrieval policy
In `qdrant-setup/qdrant-memory.env`:
- Vector-first ON:
```env
OPENCLAW_QDRANT_VECTOR_QUERY_FIRST=true
```
- Revert to native-only behavior:
```env
OPENCLAW_QDRANT_VECTOR_QUERY_FIRST=false
```

Optional full disable:
```env
OPENCLAW_QDRANT_MEMORY_ENABLED=false
```

Project-targeted context retrieval:
```env
OPENCLAW_QDRANT_ACTIVE_PROJECT=app-builder
```

## Cron example (optional)
```cron
*/30 * * * * cd /path/to/openclaw && /usr/bin/flock -n /tmp/openclaw-qdrant-index.lock ./scripts/qdrant-memory-run-from-env.sh >> ./memory/cron-qdrant-memory.log 2>&1
```

## Notes
- `scripts/qdrant-memory-index.mjs` handles:
  - deterministic UUID point IDs for Qdrant
  - idempotent collection create (`409 already exists` is accepted)
- Code indexing stores payload metadata:
  - `kind=code`
  - `project_id=<id>`
  - `rel_path=<project-relative-file-path>`
- If embedding model changes dimension, update `OPENCLAW_QDRANT_EMBEDDING_DIM` and re-index.
