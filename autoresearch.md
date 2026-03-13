# Autoresearch: Bootstrap System Prompt Cache Optimisation

## Status: CONVERGED (all major scenarios optimised)

**Metric:** `system_prompt_stable_chars` — chars before most-dynamic section. Higher is better.
**Secondary:** `system_prompt_total_chars` — total prompt length. Lower is better.
**Benchmark:** `./autoresearch.sh` → `bun scripts/autoresearch-benchmark.ts`

---

## Results across all scenarios

| Scenario                     | Before | After  | Ratio | Method                            |
| ---------------------------- | ------ | ------ | ----- | --------------------------------- |
| Per-conversation (original)  | 10,901 | 28,015 | 91.8% | Pattern scan; AGENTS.md boundary  |
| MEMORY.md daily-notes        | 29,661 | 30,598 | 99.5% | Two-prompt diff (day 1 vs day 2)  |
| workspaceNotes project-hints | 7,534  | 30,603 | 99.6% | Two-prompt diff (sprint A vs B)   |
| Skills installation          | 5,875  | 30,498 | 99.5% | Two-prompt diff (1 skill vs 2)    |
| Deployment config            | 1,263  | 30,283 | 98.4% | Two-prompt diff (config v1 vs v2) |
| Tool installation (matrix)   | 1,832  | 29,773 | 96.2% | Two-prompt diff (no plugin vs +3) |

All scenarios are at or near theoretical maximum for the combined frequency-based ordering.

---

## Dynamic tail structure (ordered most-stable-first → least-stable-last)

```
[stable boilerplate: ~7,000 chars (Tooling header, Safety, CLI, Workspace, Reply Tags, Messaging)]
[workspace files: SOUL.md → IDENTITY.md → USER.md → TOOLS.md → HEARTBEAT.md → BOOTSTRAP.md → AGENTS.md]
   ← stable prefix: ~28,015 chars for per-conversation changes ─────────────────────────────────────────
channel=whatsapp | capabilities=reactions | reasoning=on | model=...  ← per-session metadata
- Inline buttons supported/not enabled                                 ← per-channel capability
- For WhatsApp: use reactions.                                         ← per-channel hints (messageToolHints)
## Voice (TTS)                                                         ← per-config hint
## Group Chat Context                                                  ← per-conversation
## Reactions                                                           ← per-channel config
## Reasoning Format                                                    ← per-session reasoning
  ━━━ YEARLY changes ━━━
## Documentation  (docsPath)                                           ← deployment: docs path updates
## Authorized Senders  (ownerNumbers)                                  ← deployment: new device added
## Sandbox                                                             ← deployment: sandbox config
  ━━━ RARE changes ━━━
## Tool Manifest  (toolLines)                                          ← deployment: plugin installs
  ━━━ QUARTERLY changes ━━━
## Model Aliases  (modelAliasLines)                                    ← model preference updates
  ━━━ MONTHLY changes ━━━
## Skills (mandatory)  (skillsPrompt)                                  ← skill installations
  ━━━ WEEKLY changes ━━━
## Project Notes  (workspaceNotes)                                     ← sprint/project updates
  ━━━ DAILY changes ━━━
## /workspace/MEMORY.md                                                ← daily notes
```

---

## Ordering principle

The dynamic tail is ordered **most-stable-first** (least frequently changing section FIRST).
This maximises total expected KV cache savings across all change events:

- Sections that change RARELY appear EARLY → they're in the stable prefix for all more-frequent events
- Sections that change OFTEN appear LATE → maximum stable prefix when they change
- Expected cache savings = Σ(frequency × stable_prefix) across all change events

---

## Key architectural decisions

1. **AGENTS.md last among workspace files** — most frequently updated workspace file.
   Everything before AGENTS.md (SOUL.md, USER.md, TOOLS.md, etc.) stays cached even when workspace guidelines change.

2. **Per-conversation dynamic context after workspace files** — channel=, Group Chat Context,
   Reactions, Reasoning Format are injected AFTER all workspace files. Changing channels or
   group chats doesn't invalidate SOUL.md etc.

3. **Frequency-based dynamic tail ordering** — deployment config (yearly) comes before tool manifest
   (rare) which comes before model aliases (quarterly) which comes before skills (monthly) which
   comes before workspaceNotes (weekly) which comes before MEMORY.md (daily). This ordering
   maximises the TOTAL expected KV cache savings weighted by event frequency.

4. **Tool listing moved to ## Tool Manifest in dynamic tail** — the `## Tooling` section header
   and instructions remain in the stable boilerplate (position ~340), but the actual tool list
   is injected in the dynamic tail as `## Tool Manifest`. When a new plugin is installed,
   only the tail (after workspace files, deployment config) is invalidated.

5. **MEMORY.md absolutely last** — daily notes change every day. Being last ensures that the
   entire prompt (including workspace guidelines, channel config, skills, and project notes)
   is cached between day's sessions.

6. **`Reasoning:` line permanently static** — reads `Reasoning: configurable (off|on|stream,
default off)`. Actual current level emitted only when non-default in `buildRuntimeDynamicLine()`.

7. **`buildRuntimeLine()` contains only stable fields** — host/os/node only. channel,
   capabilities, thinking, model, agent, defaultModel all in `buildRuntimeDynamicLine()`.

8. **ACP guidance stable w.r.t. sandboxedRuntime** — tool descriptions and ACP harness
   guidance no longer depend on sandbox mode. ## Sandbox section tells the model ACP is
   blocked in sandbox. This makes the stable boilerplate independent of sandboxInfo.

---

## Complete list of all optimisations (all sessions)

| Change                                                                             | Scenario improved   | Magnitude        |
| ---------------------------------------------------------------------------------- | ------------------- | ---------------- |
| Reordered workspace files (AGENTS.md last)                                         | Per-conversation    | +17,226          |
| Moved Group Chat Context/Reactions to dynamic tail                                 | Group-chat          | +18,533          |
| Moved channel/capabilities to dynamic tail                                         | Multi-channel       | +17,632          |
| Made Reasoning line static                                                         | Extended thinking   | +17,637          |
| Made inline buttons text generic                                                   | Multi-channel       | +18,589          |
| Moved ttsHint and messageToolHints to dynamic tail                                 | Voice/multi-channel | +18,477          |
| Moved inline buttons conditional text to dynamic tail                              | Channel switching   | +18,477          |
| Injected MEMORY.md after dynamic tail                                              | MEMORY.md daily     | +937             |
| Moved workspaceNotes to second-to-last position                                    | workspaceNotes      | +26,069          |
| Moved skillsPrompt and modelAliasLines to dynamic tail                             | Skills install      | +24,623          |
| Made ACP guidance stable w.r.t. sandboxedRuntime                                   | Sandbox config      | —                |
| Moved docsSection, ownerNumbers, sandboxInfo to dynamic tail                       | Deploy config       | +28,856          |
| Added sessions_spawn/memory_search/memory_get to toolOrder                         | Tool install        | —                |
| Moved tool listing to ## Tool Manifest in dynamic tail                             | Tool install        | +27,941          |
| Frequency-based tail ordering (deplCfg→toolManifest→aliases→skills→wsNotes→MEMORY) | All                 | combined optimal |
