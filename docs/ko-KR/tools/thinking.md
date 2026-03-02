---
summary: "Directive syntax for /think + /verbose and how they affect model reasoning"
read_when:
  - Adjusting thinking or verbose directive parsing or defaults
title: "Thinking Levels"
generated_at: "2026-03-02T00:00:00Z"
model: claude-opus-4-6
provider: pi
source_path: docs/tools/thinking.md
workflow: 15
---

# Thinking Levels (/think directives)

## What it does

- Inline directive in any inbound body: `/t <level>`, `/think:<level>`, 또는 `/thinking <level>`.
- Levels (aliases): `off | minimal | low | medium | high | xhigh` (GPT-5.2 + Codex models only)
  - minimal → "think"
  - low → "think hard"
  - medium → "think harder"
  - high → "ultrathink" (max budget)
  - xhigh → "ultrathink+" (GPT-5.2 + Codex models only)
  - `x-high`, `x_high`, `extra-high`, `extra high`, 및 `extra_high` 는 `xhigh` 로 map 됩니다.
  - `highest`, `max` 는 `high` 로 map 됩니다.
- Provider notes:
  - Z.AI (`zai/*`) 는 binary thinking (`on`/`off`) 만 지원합니다. Any non-`off` level 은 `on` (mapped to `low`) 로 취급됩니다.

## Resolution order

1. Inline directive on the message (applies only to that message).
2. Session override (set by sending a directive-only message).
3. Global default (`agents.defaults.thinkingDefault` in config).
4. Fallback: low for reasoning-capable models; off otherwise.

## Setting a session default

- **only** the directive (whitespace allowed) 인 message 를 send 합니다, 예: `/think:medium` 또는 `/t high`.
- 이것은 현재 session 에 stick 됩니다 (per-sender by default); cleared by `/think:off` 또는 session idle reset.
- Confirmation reply 는 sent 됩니다 (`Thinking level set to high.` / `Thinking disabled.`). Level 이 invalid 이면 (예: `/thinking big`), command 는 hint 로 rejected 이고 session state 는 unchanged 입니다.
- `/think` (또는 `/think:`) 을 no argument 와 send 하여 current thinking level 을 확인합니다.

## Application by agent

- **Embedded Pi**: resolved level 은 in-process Pi agent runtime 으로 passed 됩니다.

## Verbose directives (/verbose or /v)

- Levels: `on` (minimal) | `full` | `off` (default).
- Directive-only message 는 toggle session verbose 이고 replies `Verbose logging enabled.` / `Verbose logging disabled.`; invalid levels 은 hint 를 return 하고 state 를 changing 없이 합니다.
- `/verbose off` 는 explicit session override 를 store 합니다; Sessions UI 를 통해 clear 하고 `inherit` 을 선택합니다.
- Inline directive 는 only that message 에만 affect 합니다; session/global defaults 는 otherwise apply 합니다.
- `/verbose` (또는 `/verbose:`) 을 no argument 와 send 하여 current verbose level 을 확인합니다.
- Verbose 이 on 일 때, structured tool results (Pi, other JSON agents) 를 emit 하는 agents 는 각 tool call 을 its own metadata-only message 로 send 합니다, prefixed with `<emoji> <tool-name>: <arg>` when available (path/command). 이러한 tool summaries 는 각 tool 이 start 될 때 sent (separate bubbles), not as streaming deltas.
- Tool failure summaries 는 normal mode 에서도 visible 이 남아있지만, raw error detail suffixes 는 verbose 이 `on` 또는 `full` 이 아닌 한 hidden 입니다.
- Verbose 이 `full` 일 때, tool outputs 은 또한 completion 후에 forwarded 됩니다 (separate bubble, truncated to a safe length). `/verbose on|full|off` 를 toggle 하는 동안 run 이 in-flight 이면, subsequent tool bubbles 는 new setting 을 honor 합니다.

## Reasoning visibility (/reasoning)

- Levels: `on|off|stream`.
- Directive-only message 는 toggle whether thinking blocks 는 replies 에서 shown 입니다.
- Enabled 일 때, reasoning 은 **separate message** prefixed 로 sent 됩니다 with `Reasoning:`.
- `stream` (Telegram only): streams reasoning 을 Telegram draft bubble 에 into 하는 동안 reply 는 generating 중입니다, then sends the final answer without reasoning.
- Alias: `/reason`.
- `/reasoning` (또는 `/reasoning:`) 을 no argument 와 send 하여 current reasoning level 을 확인합니다.

## Related

- Elevated mode docs 는 [Elevated mode](/tools/elevated) 에 있습니다.

## Heartbeats

- Heartbeat probe body 는 configured heartbeat prompt (default: `Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`) 입니다. Inline directives in a heartbeat message 는 usual 처럼 apply 됩니다 (but avoid changing session defaults from heartbeats).
- Heartbeat delivery 는 default 로 final payload 만입니다. 또한 separate `Reasoning:` message 를 send 하려면 (when available), set `agents.defaults.heartbeat.includeReasoning: true` 또는 per-agent `agents.list[].heartbeat.includeReasoning: true`.

## Web chat UI

- Web chat thinking selector 는 page 가 load 할 때 inbound session store/config 에서 stored level 을 mirror 합니다.
- Picking another level 은 only to the next message (`thinkingOnce`) 에만 apply 됩니다; after sending, selector 는 stored session level 로 snap back 합니다.
- Session default 를 change 하려면, `/think:<level>` directive 를 send 합니다 (as before); selector 는 next reload 후에 reflect 합니다.
