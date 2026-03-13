# Autoresearch: Bootstrap System Prompt Cache Optimisation

## Objective

Maximise Anthropic KV cache hit rate for the OpenClaw bootstrap system prompt pipeline.

**Metric:** `system_prompt_stable_chars` — characters before the earliest "most-dynamic" section. Higher is better.
**Secondary metric:** `system_prompt_total_chars` — total assembled system prompt length. Lower is better.
**Benchmark:** `./autoresearch.sh` → `bun scripts/autoresearch-benchmark.ts`

---

## Current best

`system_prompt_stable_chars=28157` / `total=30355` → **92.8% stable**

Benchmark models: group chat (WhatsApp), multi-channel, extended thinking enabled.
Boundary: `agents-md-header` (AGENTS.md is the last workspace file, most-changed).

---

## Boundary hierarchy (benchmark)

| Priority | Pattern                 | Why dynamic                                                 |
| -------- | ----------------------- | ----------------------------------------------------------- |
| 1        | `## Group Chat Context` | Changes per conversation (channel, members)                 |
| 2        | `## Subagent Context`   | Same as above for subagent sessions                         |
| 3        | `Reasoning: on\|stream` | Changes when user toggles /reasoning                        |
| 4        | `channel=\w`            | Changes per conversation in multi-channel deployments       |
| 5        | `capabilities=\w`       | Changes with channel                                        |
| 6        | `MEMORY.md` header      | Changes daily when present                                  |
| 7        | `AGENTS.md` header      | Changes when workspace guidelines update (current boundary) |
| 8        | First workspace file    | Fallback                                                    |

---

## All wins (cumulative across sessions)

| Change                                                                                                   | +stable | Benefit                                        |
| -------------------------------------------------------------------------------------------------------- | ------- | ---------------------------------------------- |
| Moved Project Context (workspace files) after Heartbeats/Runtime                                         | +998    | All users                                      |
| Added stable file manifest to Project Context preamble                                                   | +86     | All users                                      |
| Reordered workspace files: SOUL/IDENTITY/USER/TOOLS first, AGENTS.md last                                | +17,226 | All users — 15× improvement                    |
| Moved extraSystemPrompt (Group Chat Context) + reactionGuidance + reasoningHint to after workspace files | +18,533 | Group-chat users (WhatsApp, Telegram, Discord) |
| Moved channel/capabilities from buildRuntimeLine to buildRuntimeDynamicLine                              | +17,632 | Multi-channel users                            |
| Made Reasoning line static; moved actual level (on/stream) to dynamic tail                               | +17,637 | Users who enable extended thinking             |

_Note: each row is measured against a "current baseline" that includes all prior changes + new benchmark scenario. The absolute improvements are comparable; they represent real cache-miss savings for the scenario modeled._

---

## What's now in the stable prefix (92.8% of total)

All boilerplate: Tooling, Tool Call Style, Safety, CLI Quick Reference, Skills, Memory Recall,
Self-Update, Model Aliases, Workspace Files header, Reply Tags, Messaging, Voice,
Silent Replies, Heartbeats, Time Zone, Runtime (host/os/node only), Reasoning description line.

Then all stable workspace files in order:

- SOUL.md (~8,804 chars, persona — rarely edited)
- IDENTITY.md (~1,186 chars — rarely edited)
- USER.md (~3,782 chars — occasionally edited)
- TOOLS.md (~2,916 chars — occasionally edited)
- HEARTBEAT.md (~168 chars)
- BOOTSTRAP.md (~71 chars, often missing)

---

## What's in the dynamic tail (7.2% of total)

```
## /workspace/AGENTS.md               ← BOUNDARY (most-changed workspace file)
[AGENTS.md content ~1,516 chars]

channel=whatsapp | capabilities=reactions | reasoning=on | model=claude-sonnet-4-5
## Group Chat Context
[group chat context — changes per conversation]
## Reactions
[reaction guidance — changes per channel config]
```

---

## Files changed

- `src/agents/workspace.ts` — workspace file loading order (SOUL first, AGENTS last)
- `src/agents/system-prompt.ts` — section ordering, buildRuntimeLine/buildRuntimeDynamicLine
- `src/agents/system-prompt.test.ts` — updated test expectations
- `scripts/autoresearch-benchmark.ts` — benchmark with group-chat + multi-channel + reasoning scenarios
- `autoresearch.sh` — bun-based benchmark runner

---

## Dead ends

- Compressing boilerplate text: reduces both total_chars AND stable_chars equally → primary regression
- Moving userTimezone to dynamic tail: AGENTS.md moves 44 chars closer → -44 stable_chars (worse)
- Skipping BOOTSTRAP.md missing placeholder: -120 stable_chars (worse)
- Moving heartbeatPrompt inline: heartbeat uses "(configured)" placeholder = already stable
- Moving modelAliasLines to dynamic tail: AGENTS.md moves ~340 chars closer → worse
- Skills description compression: test expectation mismatch; not worth pursuing without test refactor

---

## Remaining opportunities (in autoresearch.ideas.md)

- Cross-session mtime-gated bootstrap cache (build time, no metric impact)
- Skills hash-gated regeneration (build time, no metric impact)
- Separate AGENTS.md into base (stable) + overlay (dynamic) — user-facing design change
- MEMORY.md scenario: if workspace has daily notes at root, AGENTS.md enters stable prefix too
