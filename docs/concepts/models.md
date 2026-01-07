---
summary: "Plan for models CLI: scan, list, aliases, fallbacks, status"
read_when:
  - Adding or modifying models CLI (models list/set/scan/aliases/fallbacks)
  - Changing model fallback behavior or selection UX
  - Updating model scan probes (tools/images)
---
# Models CLI plan

See [`docs/model-failover.md`](/concepts/model-failover) for how auth profiles rotate (OAuth vs API keys), cooldowns, and how that interacts with model fallbacks.

Goal: give clear model visibility + control (configured vs available), plus scan tooling
that prefers tool-call + image-capable models and maintains ordered fallbacks.

## How Clawdbot models work (quick explainer)

Clawdbot selects models in this order:
1) The configured **primary** model (`agent.model.primary`).
2) If it fails, fallbacks in `agent.model.fallbacks` (in order).
3) Auth failover happens **inside** the provider first (see [/concepts/model-failover](/concepts/model-failover)).

Key pieces:
- `provider/model` is the canonical model id (e.g. `anthropic/claude-opus-4-5`).
- `agent.models` is the **allowlist/catalog** of models Clawdbot can use, with optional aliases.
- `agent.imageModel` is only used when the primary model **can’t** accept images.
- `models.providers` lets you add custom providers + models (written to `models.json`).
- `/model <id>` switches the active model for the current session; `/model list` shows what’s allowed.

Related:
- Context limits are model-specific; long sessions may trigger compaction. See [/concepts/compaction](/concepts/compaction).

## Model recommendations

Through testing, we’ve found [Claude Opus 4.5](https://www.anthropic.com/claude/opus) is the most useful general-purpose model for anything coding-related. We suggest [GPT-5.2-Codex](https://developers.openai.com/codex/models) for coding and sub-agents. For personal assistant work, nothing comes close to Opus. If you’re going all-in on Claude, we recommend the [Claude Max $200 subscription](https://www.anthropic.com/pricing/).

## Model discussions (community notes)

Anecdotal notes from the Discord thread on January 4–5, 2026. Treat as “what people reported,” not guarantees.

**Reported working well**
- [Claude Opus 4.5](https://www.anthropic.com/claude/opus): best quality, but expensive and easy to hit limits.
- [Claude Sonnet 4.5](https://www.anthropic.com/claude/sonnet): solid fallback when Opus caps out.
- [GLM](https://www.zhipuai.cn/en/): used as a worker model under orchestration.
- [MiniMax M2.1](https://platform.minimax.io/docs/guides/models-intro): “good enough” fallback for grunt tasks.
- “Temu-Sonnet” (community shorthand) for MiniMax quality vs Claude Sonnet.
- [Gemini 3 Pro](https://deepmind.google/en/models/gemini/pro/): some users said it maps Clawdbot structure well.

**Mixed / unclear**
- [Antigravity](https://blog.google/technology/ai/google-ai-updates-november-2025/) (Claude Opus access): some reported extra Opus quota, pricing/limits unclear.

**Reported weak in Clawdbot**
- [GPT-5.2-Codex](https://developers.openai.com/codex/models) inside Clawdbot: considered rough for conversation or assistant tasks.
- [Grok](https://docs.x.ai/docs/models/grok-4): tried, abandoned.

**Tooling note**
- [Codex CLI](https://developers.openai.com/codex/cli) felt stronger than embedded use.

**Theme**
- Token burn feels higher than expected in long sessions; people suspect context buildup + tool outputs. Pruning/compaction helps. Check session logs before blaming providers. See [/concepts/session](/concepts/session) and [/concepts/model-failover](/concepts/model-failover).

## Models CLI

See [/cli](/cli) for the full command tree and CLI flags.

## Config changes

- `agent.models` (configured model catalog + aliases).
- `agent.model.primary` + `agent.model.fallbacks`.
- `agent.imageModel.primary` + `agent.imageModel.fallbacks` (optional).
- `auth.profiles` + `auth.order` for per-provider auth failover.

## Scan behavior (models scan)

Input
- OpenRouter `/models` list (filter `:free`)
- Requires OpenRouter API key from auth profiles or `OPENROUTER_API_KEY`
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
- Writes `agent.model.fallbacks` ordered.
- Writes `agent.imageModel.fallbacks` ordered (image-capable models).
- Ensures `agent.models` entries exist for selected models.
- Optional `--set-default` to set `agent.model.primary`.
- Optional `--set-image` to set `agent.imageModel.primary`.

## Runtime fallback

- On model failure: try `agent.model.fallbacks` in order.
- Per-provider auth failover uses `auth.order` (or stored profile order) **before**
  moving to the next model.
- Image routing uses `agent.imageModel` **only when configured** and the primary
  model lacks image input.
- Persist last successful provider/model to session entry; auth profile success is global.
- See [`docs/model-failover.md`](/concepts/model-failover) for auth profile rotation, cooldowns, and timeout handling.

## Tests

- Unit: scan selection ordering + probe classification.
- CLI: list/aliases/fallbacks add/remove + scan writes config.
- Status: shows last used model + fallbacks.

## Docs

- Update [`docs/configuration.md`](/gateway/configuration) with `agent.models` + `agent.model` + `agent.imageModel`.
- Keep this doc current when CLI surface or scan logic changes.
- Note provider aliases like `z.ai/*` -> `zai/*` when relevant.
- Provider ids in model refs are normalized to lowercase.
