---
summary: "Plan for models CLI: scan, list, aliases, fallbacks, status"
read_when:
  - Adding or modifying models CLI (models list/set/scan/aliases/fallbacks)
  - Changing model fallback behavior or selection UX
  - Updating model scan probes (tools/images)
---
# Models CLI plan

Goal: give clear model visibility + control (configured vs available), plus scan tooling
that prefers tool-call + image-capable models and maintains ordered fallbacks.

## Command tree (draft)

- `clawdbot models list`
  - default: configured models only
  - flags: `--all` (full catalog), `--local`, `--provider <name>`, `--json`, `--plain`
- `clawdbot models status`
  - show default model + aliases + fallbacks + allowlist
- `clawdbot models set <modelOrAlias>`
  - writes `agent.model` in config
- `clawdbot models set-image <modelOrAlias>`
  - writes `agent.imageModel` in config
- `clawdbot models aliases list|add|remove`
  - writes `agent.modelAliases`
- `clawdbot models fallbacks list|add|remove|clear`
  - writes `agent.modelFallbacks`
- `clawdbot models image-fallbacks list|add|remove|clear`
  - writes `agent.imageModelFallbacks`
- `clawdbot models scan`
  - OpenRouter :free scan; probe tool-call + image; interactive selection

## Config changes

- Add `agent.modelFallbacks: string[]` (ordered list of provider/model IDs).
- Add `agent.imageModel?: string` (optional image-capable model for image tool).
- Add `agent.imageModelFallbacks?: string[]` (ordered list for image tool).
- Keep existing:
  - `agent.model` (default)
  - `agent.allowedModels` (list filter)
  - `agent.modelAliases` (shortcut names)

## Scan behavior (models scan)

Input
- OpenRouter `/models` list (filter `:free`)
- Requires `OPENROUTER_API_KEY` (or stored OpenRouter key in auth storage)
- Optional filters: `--max-age-days`, `--min-params`, `--provider`, `--max-candidates`
- Probe controls: `--timeout`, `--concurrency`

Probes (direct pi-ai complete)
- Tool-call probe (required):
  - Provide a dummy tool, verify tool call emitted.
- Image probe (preferred):
  - Prompt includes 1x1 PNG; success if no "unsupported image" error.

Scoring/selection
- Prefer models passing tool + image for text/tool fallbacks.
- Prefer image-only models for image tool fallback (even if tool probe fails).
- Rank by: image ok, then lower tool latency, then larger context, then params.

Interactive selection (TTY)
- Multiselect list with per-model stats:
  - model id, tool ok, image ok, median latency, context, inferred params.
- Pre-select top N (default 6).
- Non-TTY: auto-select; require `--yes`/`--no-input` to apply.

Output
- Writes `agent.modelFallbacks` ordered.
- Writes `agent.imageModelFallbacks` ordered (image-capable models).
- Optional `--set-default` to set `agent.model`.
- Optional `--set-image` to set `agent.imageModel`.

## Runtime fallback

- On model failure: try `agent.modelFallbacks` in order.
- Ignore fallback entries not in `agent.allowedModels` (if allowlist set).
- Persist last successful provider/model to session entry.
- `/status` shows last used model (not just default).

## Tests

- Unit: scan selection ordering + probe classification.
- CLI: list/aliases/fallbacks add/remove + scan writes config.
- Status: shows last used model + fallbacks.

## Docs

- Update `docs/configuration.md` with `agent.modelFallbacks`.
- Keep this doc current when CLI surface or scan logic changes.
