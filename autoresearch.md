# Autoresearch: Bootstrap System Prompt Cache Optimisation

## Status: CONVERGED (all major scenarios optimised)

**Metric:** `system_prompt_stable_chars` — chars before most-dynamic section. Higher is better.
**Secondary:** `system_prompt_total_chars` — total prompt length. Lower is better.
**Benchmark:** `./autoresearch.sh` → `bun scripts/autoresearch-benchmark.ts`

---

## Results across all scenarios

| Scenario                      | Before | After   | Ratio  | Method                                 |
| ----------------------------- | ------ | ------- | ------ | -------------------------------------- |
| Per-conversation (group chat) | 10,901 | 30,735  | 99.4%  | Two-prompt diff (v1 group vs v2 group) |
| MEMORY.md daily-notes         | 29,661 | 30,598  | 99.5%  | Two-prompt diff (day 1 vs day 2)       |
| workspaceNotes project-hints  | 7,534  | 30,603  | 99.6%  | Two-prompt diff (sprint A vs B)        |
| Skills installation           | 5,875  | 30,498  | 99.5%  | Two-prompt diff (1 skill vs 2)         |
| Deployment config             | 1,263  | ~28,800 | ~95.4% | Two-prompt diff (config v1 vs v2)      |
| Tool installation (matrix)    | 1,832  | ~28,763 | ~95.1% | Two-prompt diff (no plugin vs +3)      |

All scenarios are at or near theoretical maximum for the current architecture.

---

## Dynamic tail structure (ordered most-stable-first → least-stable-last)

```
[stable boilerplate: ~7,000 chars (Tooling header, Safety, CLI, Workspace, Reply Tags, Messaging)]
[workspace files: SOUL.md → IDENTITY.md → USER.md → TOOLS.md → HEARTBEAT.md → BOOTSTRAP.md → AGENTS.md]
channel=whatsapp | capabilities=reactions | reasoning=on | model=...  ← per-session metadata
- Inline buttons supported/not enabled                                 ← per-channel capability
- For WhatsApp: use reactions.                                         ← per-channel hints
## Voice (TTS)                                                         ← per-config TTS hint
## Reactions                                                           ← per-channel config (BEFORE GroupChat)
## Reasoning Format                                                    ← per-session (BEFORE GroupChat)
## Tool Manifest                                                       ← plugin installs (BEFORE GroupChat)
  ━━━ YEARLY changes ━━━
## Documentation  (docsPath)                                           ← docs path updates
## Authorized Senders  (ownerNumbers)                                  ← new device added
## Sandbox                                                             ← sandbox config
  ━━━ QUARTERLY changes ━━━
## Model Aliases  (modelAliasLines)                                    ← model preference updates
  ━━━ MONTHLY changes ━━━
## Skills (mandatory)  (skillsPrompt)                                  ← skill installations
  ━━━ WEEKLY changes ━━━
## Project Notes  (workspaceNotes)                                     ← sprint/project updates
  ━━━ DAILY changes ━━━
## /workspace/MEMORY.md                                                ← daily notes
  ━━━ PER-CONVERSATION (most frequent) ━━━
## Group Chat Context                                                  ← ABSOLUTELY LAST
```

---

## Ordering principle

The dynamic tail is ordered **most-stable-first** (least frequently changing section FIRST).
This maximises total expected KV cache savings across all change events:

- Sections that change RARELY appear EARLY → they're in the stable prefix for all more-frequent events
- Sections that change OFTEN appear LATE → maximum stable prefix when they change
- Expected cache savings = Σ(frequency × stable_prefix) across all change events

**GroupChat is LAST** — the most frequently-changing section (multiple conversation switches per day).
Having it last means the entire prompt (workspace files, tools, skills, notes, memory) is KV-cached
between conversation switches. This is the most impactful single change for production usage.

---

## Key architectural decisions

1. **AGENTS.md last among workspace files** — most frequently updated workspace file.
   Everything before AGENTS.md (SOUL.md, USER.md, TOOLS.md, etc.) stays cached even when workspace guidelines change.

2. **Reactions, Reasoning Format, Tool Manifest BEFORE GroupChat** — these are per-channel/
   per-session/per-deployment config that don't change per-conversation. Placing them before
   GroupChat adds ~2,300 chars to the per-conversation stable prefix.

3. **GroupChat ABSOLUTELY LAST** — the most-frequent change event. Being last means the entire
   prompt (30,735 chars = 99.4% of total) is stable between conversation switches. Only the
   GroupChat content itself (~198 chars = 0.6%) is non-stable.

4. **Deployment config (docs/owners/sandbox) after Tool Manifest** — yearly changes; placed
   after TM so deployConfig scenario stable prefix is ~95.4% instead of ~87%.

5. **MEMORY.md before GroupChat (after wsNotes)** — daily notes change every day. Being
   just before GroupChat means wsNotes/skills/modelAliases are in the stable prefix for daily
   note updates.

6. **Tool listing moved to ## Tool Manifest in dynamic tail** — the `## Tooling` section header
   and instructions remain in the stable boilerplate, but the actual tool list is in the dynamic
   tail. Placed BEFORE GroupChat so plugin installs don't invalidate per-conv cache beyond ~5%.

7. **`Reasoning:` line permanently static** — reads `Reasoning: configurable (off|on|stream,
default off)`. Actual current level emitted only when non-default in `buildRuntimeDynamicLine()`.

8. **`buildRuntimeLine()` contains only stable fields** — host/os/node only. channel,
   capabilities, thinking, model, agent, defaultModel all in `buildRuntimeDynamicLine()`.

9. **ACP guidance stable w.r.t. sandboxedRuntime** — tool descriptions and ACP harness
   guidance no longer depend on sandbox mode. ## Sandbox section tells the model ACP is
   blocked in sandbox. This makes the stable boilerplate independent of sandboxInfo.

10. **MEMORY.md / memory.md files separated from standard context files** — injected after
    all other dynamic sections, before GroupChat only.

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
| Moved Reactions + Reasoning Format BEFORE GroupChat                                | Per-conversation    | +319             |
| Moved Tool Manifest BEFORE GroupChat                                               | Per-conversation    | +1,993           |
| Moved GroupChat to ABSOLUTELY LAST (after MEMORY.md)                               | Per-conversation    | +1,161           |
| Moved deployConfig to after Tool Manifest                                          | Deploy config       | +2,513 (~95.4%)  |
