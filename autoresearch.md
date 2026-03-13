# Autoresearch: Bootstrap System Prompt Cache Optimisation

## Status: CONVERGED (all major scenarios optimised)

**Metric:** `system_prompt_stable_chars` — chars before most-dynamic section. Higher is better.
**Secondary:** `system_prompt_total_chars` — total prompt length. Lower is better.
**Benchmark:** `./autoresearch.sh` → `bun scripts/autoresearch-benchmark.ts`

---

## Results across all scenarios

| Scenario                     | Before | After  | Ratio | Method                           |
| ---------------------------- | ------ | ------ | ----- | -------------------------------- |
| Per-conversation (original)  | 10,901 | 28,015 | 91.8% | Pattern scan; AGENTS.md boundary |
| MEMORY.md daily-notes        | ?      | 30,598 | 99.5% | Two-prompt diff (day 1 vs day 2) |
| workspaceNotes project-hints | 7,534  | 30,603 | 99.6% | Two-prompt diff (sprint A vs B)  |
| Skills installation          | 5,875  | 30,498 | 99.5% | Two-prompt diff (1 skill vs 2)   |

All scenarios are at or near theoretical maximum (non-stable portion = just the changed content).

---

## Dynamic tail structure (ordered least→most frequently changing)

```
[boilerplate: ~7,000 chars (Tooling, Safety, CLI, Workspace, Docs, Auth Senders)]
[SOUL.md][IDENTITY.md][USER.md][TOOLS.md][HEARTBEAT.md][BOOTSTRAP.md][AGENTS.md]
   ← stable prefix: 28,015 chars for per-conversation changes ──────────────────
channel= | capabilities= | reasoning= | model= | agent=       per-session metadata
- Inline buttons supported/not enabled                        per-channel capability
- For WhatsApp: use reactions.                                per-channel hints (messageToolHints)
## Voice (TTS)                                                per-config hint
## Group Chat Context                                         per-conversation
## Reactions                                                  per-channel config
## Reasoning Format                                           per-session reasoning
## Model Aliases                                              per-deployment (quarterly change)
## Skills (mandatory)                                         per-deployment (monthly change)
## Project Notes                                              per-project (weekly change)
## MEMORY.md                                                  per-day (daily change)
```

---

## Key architectural decisions

1. **AGENTS.md last among workspace files** — most frequently updated workspace file. Everything before AGENTS.md (SOUL.md, USER.md, TOOLS.md, etc.) stays cached even when workspace guidelines change.

2. **Per-conversation dynamic context after workspace files** — channel=, Group Chat Context, Reactions, Reasoning Format are injected AFTER all workspace files. Changing channels or group chats doesn't invalidate SOUL.md etc.

3. **Deployment-variable config in dynamic tail** — modelAliasLines, skillsPrompt, workspaceNotes, and MEMORY.md are injected at the END of the prompt, ordered least→most frequently changing. Installing a new skill doesn't invalidate SOUL.md, workspace files, or group-chat context.

4. **MEMORY.md absolutely last** — daily notes change every day. Being last ensures that the entire prompt (including workspace guidelines, channel config, skills, and project notes) is cached between day's sessions.

5. **`Reasoning:` line static** — instead of embedding the dynamic level value, the line reads `Reasoning: configurable (off|on|stream, default off)`. The actual current level is emitted only in `buildRuntimeDynamicLine()`.

---

## Complete list of all optimisations (all sessions)

| Change                                                 | Scenario improved   | Magnitude |
| ------------------------------------------------------ | ------------------- | --------- |
| Reordered workspace files (AGENTS.md last)             | Per-conversation    | +17,226   |
| Moved Group Chat Context/Reactions to dynamic tail     | Group-chat          | +18,533   |
| Moved channel/capabilities to dynamic tail             | Multi-channel       | +17,632   |
| Made Reasoning line static                             | Extended thinking   | +17,637   |
| Made inline buttons text generic                       | Multi-channel       | +18,589   |
| Moved ttsHint and messageToolHints to dynamic tail     | Voice/multi-channel | +18,477   |
| Moved inline buttons conditional text to dynamic tail  | Channel switching   | +18,477   |
| Injected MEMORY.md after dynamic tail                  | MEMORY.md daily     | +937      |
| Moved workspaceNotes to second-to-last position        | workspaceNotes      | +26,069   |
| Moved skillsPrompt and modelAliasLines to dynamic tail | Skills install      | +24,623   |

---

## Remaining opportunities (lower priority)

See autoresearch.ideas.md for details. Key remaining items:

- ownerNumbers (appears at ~3,107): rarely changes (device changes). Low priority.
- docsPath (appears at ~3,096): very rarely changes (OpenClaw updates). Very low priority.
- sandboxInfo (appears at ~3,061): essentially never changes. Very low priority.
- toolNames (appears at ~338): complex (woven through many sections). Low priority.

The pattern for fixing each: move from stable boilerplate to dynamic tail before modelAliasLines. Fix requires init_experiment for each scenario.
