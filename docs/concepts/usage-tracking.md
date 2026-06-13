---
summary: "Usage tracking surfaces and credential requirements"
read_when:
  - You are wiring provider usage/quota surfaces
  - You need to explain usage tracking behavior or auth requirements
title: "Usage tracking"
---

## What it is

- Pulls provider usage/quota directly from their usage endpoints.
- No estimated costs; only provider-reported quota windows or account-state
  summaries.
- Human-readable quota-window status output is normalized to `X% left`, even
  when an upstream API reports consumed quota, remaining quota, or only raw
  counts. Providers without resettable quota windows can show provider summary
  text instead, such as a balance.
- Session-level `/status` and `session_status` can fall back to the latest
  transcript usage entry when the live session snapshot is sparse. That
  fallback fills missing token/cache counters, can recover the active runtime
  model label, and prefers the larger prompt-oriented total when session
  metadata is missing or smaller. Existing nonzero live values still win.

## Where it shows up

- `/status` in chats: emoji-rich status card with session tokens + estimated cost (API key only). Provider usage shows for the **current model provider** when available as a normalized `X% left` window or provider summary text.
- `/usage off|tokens|full` in chats: per-response usage footer (OAuth shows tokens only).
- `/usage cost` in chats: local cost summary aggregated from OpenClaw session logs.
- CLI: `openclaw status --usage` prints a full per-provider breakdown.
- CLI: `openclaw channels list` prints the same usage snapshot alongside provider config (use `--no-usage` to skip).
- macOS menu bar: "Usage" section under Context (only if available).

## Custom `/usage full` footer

`/usage full` shows a built-in compact footer with model, reasoning, fast/slow,
context window, turn tokens, cache, and cost when those fields are available. No
template file is required.

`messages.usageTemplate` is only for advanced custom layouts. The value is a
JSON file path (supports `~`) or an inline object, and it replaces the built-in
footer when valid:

```json
{
  "messages": {
    "usageTemplate": "~/.openclaw/usage-footer.json"
  }
}
```

Missing, unreadable, invalid, or empty templates fall back to the built-in
footer.

### Shape

```jsonc
{
  "schema": "openclaw.usageBar.v1",
  "scales": { "<name>": "low-to-high glyphs" }, // string (1 glyph/char) or array
  "aliases": { "<table>": { "<value>": "<label>" } },
  "output": {
    "sep": "", // joins surviving pieces
    "default": [
      /* pieces */
    ], // fallback for any surface
    "surfaces": {
      "discord": [
        /* pieces */
      ],
      "telegram": [
        /* pieces */
      ],
    },
  },
}
```

Each surface is an ordered list of **pieces**; the engine renders each, drops
empties, and joins survivors with `sep`. A surface with no entry uses
`output.default`.

### Contract Paths

A piece reads values from the per-turn contract by dot-path. Absent values are
empty (so a `when` guard or a `|fallback` keeps the piece clean).

| Path                                                                                | Meaning                                |
| ----------------------------------------------------------------------------------- | -------------------------------------- |
| `surface`                                                                           | channel id (`discord`/`telegram`/etc.) |
| `model.provider` / `model.display_name`                                             | provider id / model id                 |
| `model.reasoning`                                                                   | effort (`off` through `xhigh`)         |
| `model.is_fallback` / `model.is_override`                                           | bool: fallback used / model pinned     |
| `state.fast_mode`                                                                   | bool: fast vs slow                     |
| `context.max_tokens` / `context.pct_used`                                           | window budget / 0-100 used             |
| `usage.input_tokens` / `usage.output_tokens` / `usage.cache_hit_pct`                | turn aggregate                         |
| `usage.last.input_tokens` / `usage.last.output_tokens` / `usage.last.cache_hit_pct` | final model call only                  |
| `cost.turn_usd`                                                                     | estimated turn cost                    |
| `identity.name` / `identity.emoji`                                                  | agent name / chosen emoji              |

(Provider rate-limit windows are **not** in this contract.)

### Verbs

Pipe a value through verbs left to right; a non-verb segment is the fallback.

| Verb            | Effect                                | Example                           |
| --------------- | ------------------------------------- | --------------------------------- |
| `num`           | compact count                         | `272000 -> 272k`                  |
| `fixed:N`       | N decimals (default 2)                | `0.0377`                          |
| `dur`           | seconds to duration                   | `14820 -> 4h07m`                  |
| `pct`           | append `%`                            | `96 -> 96%`                       |
| `inv`           | `100 - x`                             | for used to remaining             |
| `alias:TABLE`   | lookup in `aliases`, echo if unlisted | `medium -> 🌗`                    |
| `meter:W:SCALE` | W-cell glyph bar over a 0-100 value   | `[⣿⣿⠐⠐⠐]` (`meter:1` = one glyph) |

### Piece forms

- `{ "text": "📚 {context.max_tokens|num}" }`: literal + interpolation.
- `{ "when": "<path>", "text": "..." }`: render only if the path is truthy.
- `{ "map": "<path>", "cases": { "true": "⚡", "false": "🐌" } }`: value to glyph.
- `{ "each": "limits.windows", "item": "{label}" }`: iterate an array.

### Example

```jsonc
{
  "schema": "openclaw.usageBar.v1",
  "scales": { "braille": "⠐⡀⡄⡆⡇⣇⣧⣷⣿" },
  "aliases": { "reasoning": { "medium": "🌗", "high": "🌕" } },
  "output": {
    "surfaces": {
      "discord": [
        { "text": "{model.display_name}" },
        { "when": "model.reasoning", "text": " {model.reasoning|alias:reasoning}" },
        { "map": "state.fast_mode", "cases": { "true": " ⚡", "false": " 🐌" } },
        {
          "when": "context.max_tokens",
          "text": " | 📚 [{context.pct_used|meter:5:braille}]{context.max_tokens|num}",
        },
      ],
    },
  },
}
```

renders e.g. `claude-sonnet-4-6 🌗 🐌 | 📚 [⣿⣿⣿⣿⣧]272k`.

## Providers + credentials

- **Anthropic (Claude)**: OAuth tokens in auth profiles.
- **GitHub Copilot**: OAuth tokens in auth profiles.
- **Gemini CLI**: OAuth tokens in auth profiles.
  - JSON usage falls back to `stats`; `stats.cached` is normalized into
    `cacheRead`.
- **OpenAI Codex**: OAuth tokens in auth profiles (accountId used when present).
- **MiniMax**: API key or MiniMax OAuth auth profile. OpenClaw treats
  `minimax`, `minimax-cn`, and `minimax-portal` as the same MiniMax quota
  surface, prefers stored MiniMax OAuth when present, and otherwise falls back
  to `MINIMAX_CODE_PLAN_KEY`, `MINIMAX_CODING_API_KEY`, or `MINIMAX_API_KEY`.
  Usage polling derives the Coding Plan host from `models.providers.minimax-portal.baseUrl`
  or `models.providers.minimax.baseUrl` when configured, and otherwise uses the
  MiniMax CN host.
  MiniMax's raw `usage_percent` / `usagePercent` fields mean **remaining**
  quota, so OpenClaw inverts them before display; count-based fields win when
  present.
  - Coding-plan window labels come from provider hours/minutes fields when
    present, then fall back to the `start_time` / `end_time` span.
  - If the coding-plan endpoint returns `model_remains`, OpenClaw prefers the
    chat-model entry, derives the window label from timestamps when explicit
    `window_hours` / `window_minutes` fields are absent, and includes the model
    name in the plan label.
- **Xiaomi MiMo**: API key via env/config/auth store (`XIAOMI_API_KEY`).
- **z.ai**: API key via env/config/auth store.
- **DeepSeek**: API key via env/config/auth store (`DEEPSEEK_API_KEY`).
  OpenClaw calls DeepSeek's balance endpoint and shows the provider-reported
  balance as text instead of a percent-left quota window.

Usage is hidden when no usable provider usage auth can be resolved. Providers
can supply plugin-specific usage auth logic; otherwise OpenClaw falls back to
matching OAuth/API-key credentials from auth profiles, environment variables,
or config.

## Related

- [Token use and costs](/reference/token-use)
- [API usage and costs](/reference/api-usage-costs)
- [Prompt caching](/reference/prompt-caching)
