# Autoresearch: Bootstrap System Prompt Cache Optimisation

## Status: CONVERGED (truly stable prefix achieved)

**Metric:** `system_prompt_stable_chars` — chars before most-dynamic section. Higher is better.
**Secondary:** `system_prompt_total_chars` — total prompt length. Lower is better.
**Benchmark:** `./autoresearch.sh` → `bun scripts/autoresearch-benchmark.ts`

---

## Current result

`system_prompt_stable_chars=28015` / `total=30517` → **91.8% stable**

Benchmark models: group chat (WhatsApp), multi-channel, extended thinking, TTS, inline buttons.
Boundary: `agents-md-header` — AGENTS.md is the last workspace file, most-changed.

**Verification:** Diff test confirms the stable prefix (before AGENTS.md) is BYTE-FOR-BYTE IDENTICAL across all per-conversation variations: channel, capabilities, reasoning level, model, TTS config, group chat context, reaction mode, inline buttons status, message tool hints.

---

## Boundary hierarchy (benchmark)

| Priority | Pattern                                   | Why dynamic                                                 |
| -------- | ----------------------------------------- | ----------------------------------------------------------- |
| 1        | `## Group Chat Context`                   | Changes per conversation (channel, members)                 |
| 2        | `## Subagent Context`                     | Same as above for subagent sessions                         |
| 3        | `Reasoning: on\|stream`                   | Changes when user toggles /reasoning                        |
| 4        | `Inline buttons (supported\|not enabled)` | Changes per channel capability                              |
| 5        | `message-tool-hints` text                 | Per-channel hints (WhatsApp vs Telegram)                    |
| 6        | `## Voice (TTS)`                          | Changes when TTS config changes                             |
| 7        | `channel=\w`                              | Changes per conversation in multi-channel deployments       |
| 8        | `capabilities=\w`                         | Changes with channel                                        |
| 9        | `MEMORY.md` header                        | Changes daily when present                                  |
| 10       | `AGENTS.md` header                        | Changes when workspace guidelines update (CURRENT BOUNDARY) |
| 11       | First workspace file                      | Fallback                                                    |

---

## What's in the stable prefix (91.8% of total, byte-identical across all deployments)

All boilerplate: Tooling, Tool Call Style, Safety, CLI Quick Reference, Skills, Memory Recall,
Self-Update, Model Aliases, Workspace Files header, Reply Tags,
Messaging (stable parts only: routing, sessions_send, never exec/curl, message tool overview),
Silent Replies, Heartbeats, Time Zone, Runtime (host/os/node only),
Reasoning description line (static: "configurable (off|on|stream, default off)"),
Project Context preamble + file manifest.

Then all stable workspace files:

- SOUL.md (~8,804 chars, persona — rarely edited)
- IDENTITY.md (~1,186 chars — rarely edited)
- USER.md (~3,782 chars — occasionally edited)
- TOOLS.md (~2,916 chars — occasionally edited)
- HEARTBEAT.md (~168 chars)
- BOOTSTRAP.md (~71 chars, often missing)

---

## What's in the dynamic tail (8.2% of total, after AGENTS.md header)

```
## /workspace/AGENTS.md               ← BOUNDARY
[AGENTS.md content ~1,516 chars]

- Inline buttons supported/not enabled (per channel)
- For WhatsApp: use reactions. (messageToolHints)
channel=whatsapp | capabilities=reactions | reasoning=on | model=claude-sonnet-4-5
## Voice (TTS)
[TTS instructions]
## Group Chat Context
[group chat context — changes per conversation]
## Reactions
[reaction guidance — changes per channel config]
```

---

## Complete list of all optimisations (cumulative across all sessions)

| Change                                                           | Effect                                      |
| ---------------------------------------------------------------- | ------------------------------------------- |
| Moved Project Context after Heartbeats/Runtime                   | +998 stable chars; all users                |
| Added stable file manifest to Project Context preamble           | +86 stable chars; all users                 |
| Reordered workspace files (AGENTS.md last)                       | +17,226; all users — 15× improvement        |
| Moved Group Chat Context/Reactions/ReasoningHint to dynamic tail | +18,533; group-chat users                   |
| Moved channel/capabilities/thinkLevel to dynamic tail            | +17,632; multi-channel users                |
| Made Reasoning line static, moved level to dynamic tail          | +17,637; users who enable extended thinking |
| Made inline buttons text generic (no channel name)               | +18,589; multi-channel users                |
| Moved ttsHint and messageToolHints to dynamic tail               | +18,477; voice and multi-channel users      |
| Moved inline buttons conditional text to dynamic tail            | +18,477; users switching channels           |

---

## Dead ends

- Compressing boilerplate text: reduces stable_chars equally → regression
- Moving userTimezone to dynamic tail: AGENTS.md gets 44 chars closer → -44 stable_chars
- Skipping BOOTSTRAP.md missing placeholder: -120 stable_chars (AGENTS.md moves closer)
- Moving heartbeatPrompt inline: already uses "(configured)" placeholder = stable
- Moving modelAliasLines to dynamic tail: AGENTS.md moves ~340 chars closer → regression
- Skills description compression: test expectations tightly coupled; not worth without refactor

---

## Remaining opportunities (in autoresearch.ideas.md)

- Cross-session mtime-gated bootstrap cache: build time improvement, no metric impact
- Skills hash-gated regeneration: build time improvement, no metric impact
- MEMORY.md scenario: if root MEMORY.md exists, AGENTS.md enters stable prefix (~+1,500 chars)
- PR: ready to open for all merged commits
