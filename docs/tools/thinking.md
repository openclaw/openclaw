---
summary: "Directive syntax for /think, /fast, /verbose, and reasoning visibility"
read_when:
  - Adjusting thinking, fast-mode, or verbose directive parsing or defaults
title: "Thinking Levels"
---

# Thinking Levels (/think directives)

## What it does

- Inline directive in any inbound body: `/t <level>`, `/think:<level>`, or `/thinking <level>`.
- Levels (aliases): `off | minimal | low | medium | high | xhigh | adaptive`
  - minimal → “think”
  - low → “think hard”
  - medium → “think harder”
  - high → “ultrathink” (max budget)
  - xhigh → “ultrathink+” (GPT-5.2 + Codex models only)
  - adaptive → provider-managed adaptive reasoning budget (supported for Anthropic Claude 4.6 model family)
  - `x-high`, `x_high`, `extra-high`, `extra high`, and `extra_high` map to `xhigh`.
  - `highest`, `max` map to `high`.
- Provider notes:
  - Anthropic Claude 4.6 models default to `adaptive` when no explicit thinking level is set.
  - Z.AI (`zai/*`) only supports binary thinking (`on`/`off`). Any non-`off` level is treated as `on` (mapped to `low`).
  - Moonshot (`moonshot/*`) maps `/think off` to `thinking: { type: "disabled" }` and any non-`off` level to `thinking: { type: "enabled" }`. When thinking is enabled, Moonshot only accepts `tool_choice` `auto|none`; OpenClaw normalizes incompatible values to `auto`.

## Resolution order

1. Inline directive on the message (applies only to that message).
2. Session override (set by sending a directive-only message).
3. Per-agent default (`agents.list[].thinkingDefault` in config).
4. Global default (`agents.defaults.thinkingDefault` in config).
5. Fallback: `adaptive` for Anthropic Claude 4.6 models, `low` for other reasoning-capable models, `off` otherwise.

## Setting a session default

- Send a message that is **only** the directive (whitespace allowed), e.g. `/think:medium` or `/t high`.
- That sticks for the current session (per-sender by default); cleared by `/think:off` or session idle reset.
- Confirmation reply is sent (`Thinking level set to high.` / `Thinking disabled.`). If the level is invalid (e.g. `/thinking big`), the command is rejected with a hint and the session state is left unchanged.
- Send `/think` (or `/think:`) with no argument to see the current thinking level.

## Application by agent

- **Embedded Pi**: the resolved level is passed to the in-process Pi agent runtime.

## Fast mode (/fast)

- Levels: `on|off`.
- Directive-only message toggles a session fast-mode override and replies `Fast mode enabled.` / `Fast mode disabled.`.
- Send `/fast` (or `/fast status`) with no mode to see the current effective fast-mode state.
- OpenClaw resolves fast mode in this order:
  1. Inline/directive-only `/fast on|off`
  2. Session override
  3. Per-agent default (`agents.list[].fastModeDefault`)
  4. Per-model config: `agents.defaults.models["<provider>/<model>"].params.fastMode`
  5. Fallback: `off`
- For `openai/*`, fast mode applies the OpenAI fast profile: `service_tier=priority` when supported, plus low reasoning effort and low text verbosity.
- For `openai-codex/*`, fast mode applies the same low-latency profile on Codex Responses. OpenClaw keeps one shared `/fast` toggle across both auth paths.
- For direct `anthropic/*` API-key requests, fast mode maps to Anthropic service tiers: `/fast on` sets `service_tier=auto`, `/fast off` sets `service_tier=standard_only`.
- Anthropic fast mode is API-key only. OpenClaw skips Anthropic service-tier injection for Claude setup-token / OAuth auth and for non-Anthropic proxy base URLs.

## Verbose directives (/verbose or /v)

- Levels: `on` (minimal) | `full` | `off` (default).
- Directive-only message toggles session verbose and replies `Verbose logging enabled.` / `Verbose logging disabled.`; invalid levels return a hint without changing state.
- `/verbose off` stores an explicit session override; clear it via the Sessions UI by choosing `inherit`.
- Inline directive affects only that message; session/global defaults apply otherwise.
- Send `/verbose` (or `/verbose:`) with no argument to see the current verbose level.
- When verbose is on, agents that emit structured tool results (Pi, other JSON agents) send each tool call back as its own metadata-only message, prefixed with `<emoji> <tool-name>: <arg>` when available (path/command). These tool summaries are sent as soon as each tool starts (separate bubbles), not as streaming deltas.
- Tool failure summaries remain visible in normal mode, but raw error detail suffixes are hidden unless verbose is `on` or `full`.
- When verbose is `full`, tool outputs are also forwarded after completion (separate bubble, truncated to a safe length). If you toggle `/verbose on|full|off` while a run is in-flight, subsequent tool bubbles honor the new setting.

## Reasoning visibility (/reasoning)

- Levels: `on|off|stream`.
- Directive-only message toggles whether thinking blocks are shown in replies.
- When enabled, reasoning is sent as a **separate message** prefixed with `Reasoning:`.
- `stream` (Telegram only): streams reasoning into the Telegram draft bubble while the reply is generating, then sends the final answer without reasoning.
- Alias: `/reason`.
- Send `/reasoning` (or `/reasoning:`) with no argument to see the current reasoning level.
- Resolution order: inline directive, then session override, then per-agent default (`agents.list[].reasoningDefault`), then fallback (`off`).

## Related

- Elevated mode docs live in [Elevated mode](/tools/elevated).

## Heartbeats

- Heartbeat probe body is the configured heartbeat prompt (default: `Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`). Inline directives in a heartbeat message apply as usual (but avoid changing session defaults from heartbeats).
- Heartbeat delivery defaults to the final payload only. To also send the separate `Reasoning:` message (when available), set `agents.defaults.heartbeat.includeReasoning: true` or per-agent `agents.list[].heartbeat.includeReasoning: true`.

## Web chat UI

- The web chat thinking selector mirrors the session's stored level from the inbound session store/config when the page loads.
- Picking another level applies only to the next message (`thinkingOnce`); after sending, the selector snaps back to the stored session level.
- To change the session default, send a `/think:<level>` directive (as before); the selector will reflect it after the next reload.
