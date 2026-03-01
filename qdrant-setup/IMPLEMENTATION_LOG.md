# Implementation Log

Date: 2026-03-01

## Scope completed
- Cloned forked OpenClaw repo to `/root/clawd/openclaw`
- Added Qdrant sidecar indexing/search scripts
- Enhanced indexer with multi-project codebase indexing (`kind=code`, `project_id`, `rel_path`)
- Added env template with placeholders only (no secrets)
- Added sidecar documentation and runbook
- Added reversible vector-first policy switches

## Secret handling
- API keys are expected in `qdrant-setup/qdrant-memory.env` (ignored by git)
- No runtime secret values included in committed files
