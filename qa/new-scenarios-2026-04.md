# QA Scenario Expansion - Round 2

Ten repo-grounded candidate scenarios to add after the current seed suite.

## 1. On-demand memory tools in channel context

- Goal: verify the agent uses `memory_search` plus `memory_get` instead of bluffing when a channel message asks about prior notes.
- Flow:
  - Seed `MEMORY.md` or `memory/*.md` with a fact not present in the current transcript.
  - Ask in a channel thread for that fact.
  - Verify tool usage and final answer accuracy.
- Pass:
  - `memory_search` runs first.
  - `memory_get` narrows to the right lines.
  - Final answer cites the remembered fact correctly without cross-session leakage.
- Docs: `docs/concepts/memory.md`, `docs/concepts/memory-search.md`
- Code: `extensions/memory-core/src/tools.ts`, `extensions/memory-core/src/prompt-section.ts`

## 2. Memory failure fallback

- Goal: verify memory failure is graceful when embeddings/search are unavailable.
- Flow:
  - Disable or break the embedding-backed memory path.
  - Ask for prior-note recall.
  - Verify the agent surfaces uncertainty and next action instead of hallucinating.
- Pass:
  - Tool failure does not crash the run.
  - Agent says it checked and could not confirm.
  - Report includes the remediation hint.
- Docs: `docs/concepts/memory.md`, `docs/help/faq.md`
- Code: `extensions/memory-core/src/tools.shared.ts`, `extensions/memory-core/src/tools.citations.test.ts`

## 3. Model switch with tool continuity

- Goal: verify model switching preserves session context and tool availability, not just plain text continuity.
- Flow:
  - Start on one model.
  - Switch to another configured model.
  - Ask for a tool-using follow-up such as file read or memory lookup.
- Pass:
  - Switch is reflected in runtime state.
  - Tool call still succeeds after the switch.
  - Final answer keeps prior context.
- Docs: `docs/help/testing.md`, `docs/concepts/model-failover.md`
- Code: `extensions/qa-lab/src/suite.ts`, `docs/web/webchat.md`

## 4. MCP-backed recall via QMD/mcporter

- Goal: verify an MCP-backed tool path works end to end, not just core tools.
- Flow:
  - Enable `memory.qmd.mcporter`.
  - Ask for recall that should route through the QMD MCP bridge.
  - Verify response and captured MCP execution path.
- Pass:
  - MCP-backed search path is used.
  - Returned snippet matches the right note.
  - Failure mode is explicit if the daemon/tool is missing.
- Docs: `docs/gateway/secrets.md`, `docs/concepts/memory-qmd.md`
- Code: `extensions/memory-core/src/memory/qmd-manager.ts`, `extensions/memory-core/src/memory/qmd-manager.test.ts`

## 5. Skill visibility and invocation

- Goal: verify the agent sees a workspace/project skill and actually uses it.
- Flow:
  - Add a simple workspace or `.agents` skill.
  - Confirm skill visibility through runtime inventory.
  - Ask for a task that should trigger the skill.
- Pass:
  - Skill appears in `skills.status`.
  - Agent invocation reflects the installed skill instructions.
  - Per-agent allowlist behavior is respected.
- Docs: `docs/tools/skills.md`, `docs/gateway/protocol.md`, `docs/gateway/configuration.md`
- Code: `.agents/skills/openclaw-qa-testing/SKILL.md`, `docs/gateway/protocol.md`

## 6. Skill install and hot availability

- Goal: verify a newly installed skill becomes usable without a broken intermediate state.
- Flow:
  - Install a ClawHub or gateway-managed skill.
  - Re-check skill inventory.
  - Ask the agent to perform the skill-backed task.
- Pass:
  - Install succeeds.
  - `skills.status` or `skills.bins` reflects the new skill.
  - Agent can use the skill immediately or after the expected reload path.
- Docs: `docs/tools/skills.md`, `docs/cli/skills.md`, `docs/gateway/protocol.md`
- Code: `docs/gateway/protocol.md`, `docs/tools/skills.md`

## 7. Native image generation

- Goal: verify `image_generate` appears only when configured and returns a real attachment/artifact.
- Flow:
  - Configure `agents.defaults.imageGenerationModel.primary`.
  - Ask for a simple generated image.
  - Verify generated media is returned in the reply path.
- Pass:
  - `image_generate` is in the effective tool set.
  - Generation succeeds with the configured provider/model.
  - Output is attached and the agent summarizes what it created.
- Docs: `docs/tools/image-generation.md`, `docs/providers/openai.md`
- Code: `src/agents/openclaw-tools.image-generation.test.ts`, `src/image-generation/runtime.ts`

## 8. Hot config patch without restart

- Goal: verify a safe config edit hot-applies and changes behavior immediately.
- Flow:
  - Use `config.patch` to change a hot-reloadable field such as agent skill visibility or message behavior.
  - Retry the task in the same gateway lifetime.
- Pass:
  - Patch succeeds.
  - No disruptive restart loop.
  - New behavior is live immediately.
- Docs: `docs/gateway/configuration.md`, `docs/gateway/protocol.md`
- Code: `docs/gateway/configuration.md`, `docs/web/control-ui.md`

## 9. Restart-required config apply with wake-up

- Goal: verify a restart-required config change restarts cleanly and wakes the session back up.
- Flow:
  - Use `config.apply` or `update.run` on a restart-required surface.
  - Provide `sessionKey` so the operator gets the post-restart ping.
  - Resume the task after restart.
- Pass:
  - Restart happens once.
  - Session wake-up ping arrives.
  - Agent continues in the same logical workflow after restart.
- Docs: `docs/gateway/configuration.md`, `docs/web/control-ui.md`
- Code: `docs/gateway/configuration.md`, `docs/gateway/protocol.md`

## 10. Runtime inventory drift check

- Goal: verify the reported tool and skill inventory matches what the agent can really use after config/plugin changes.
- Flow:
  - Read `tools.effective` and `skills.status`.
  - Ask the agent to use one enabled thing and one disabled thing.
  - Compare actual behavior vs reported inventory.
- Pass:
  - Enabled item is callable.
  - Disabled item is absent or blocked for the right reason.
  - Inventory and runtime behavior stay in sync.
- Docs: `docs/gateway/protocol.md`, `docs/web/webchat.md`
- Code: `docs/gateway/protocol.md`, `docs/web/control-ui.md`

## Best next additions to the executable suite

If we only promote three right away:

1. On-demand memory tools in channel context
2. Native image generation
3. Hot config patch without restart
