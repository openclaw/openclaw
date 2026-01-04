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

- `clawdis models list`
  - default: configured models only
  - flags: `--all` (full catalog), `--local`, `--provider <name>`, `--json`, `--plain`
- `clawdis models status`
  - show default model + last used + aliases + fallbacks
- `clawdis models set <modelOrAlias>`
  - writes `agent.model` in config
- `clawdis models aliases list|add|remove`
  - writes `agent.modelAliases`
- `clawdis models fallbacks list|add|remove|clear`
  - writes `agent.modelFallbacks`
- `clawdis models scan`
  - OpenRouter :free scan; probe tool-call + image; interactive selection

## Config changes

- Add `agent.modelFallbacks: string[]` (ordered list of provider/model IDs).
- Keep existing:
  - `agent.model` (default)
  - `agent.allowedModels` (list filter)
  - `agent.modelAliases` (shortcut names)

## Scan behavior (models scan)

Input
- OpenRouter `/models` list (filter `:free`)
- Optional filters: `--max-age-days`, `--min-params`, `--provider`, `--max-candidates`

Probes (direct pi-ai complete)
- Tool-call probe (required):
  - Provide a dummy tool, verify tool call emitted.
- Image probe (preferred):
  - Prompt includes 1x1 PNG; success if no "unsupported image" error.

Scoring/selection
- Prefer models passing tool + image.
- Fallback to tool-only if no tool+image pass.
- Rank by: tool+image first, then lower median latency, then larger context.

Interactive selection (TTY)
- Multiselect list with per-model stats:
  - model id, tool ok, image ok, median latency, context, inferred params.
- Pre-select top N (default 6).
- Non-TTY: auto-select; require `--yes` or use defaults.

Output
- Writes `agent.modelFallbacks` ordered.
- Optional `--set-default` to set `agent.model`.

## Runtime fallback

- On model failure: try `agent.modelFallbacks` in order.
- Persist last successful provider/model to session entry.
- `/status` shows last used model (not just default).

## Tests

- Unit: scan selection ordering + probe classification.
- CLI: list/aliases/fallbacks add/remove + scan writes config.
- Status: shows last used model + fallbacks.

## Docs

- Update `docs/configuration.md` with `agent.modelFallbacks`.
- Keep this doc current when CLI surface or scan logic changes.
