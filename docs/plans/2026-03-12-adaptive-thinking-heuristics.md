# Adaptive Thinking Heuristics Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Teach the embedded OpenClaw agent when to call `set_thinking_level` only for models that do not already provide native adaptive thinking.

**Architecture:** Gate `set_thinking_level` registration per active provider/model using the existing native-adaptive capability helper, then let prompt visibility follow tool availability automatically. Align the tool description and adaptive-thinking prompt guidance only for models where the tool remains available.

**Tech Stack:** TypeScript, Vitest, embedded prompt builder, built-in tool metadata

---

## Task 1: Gating tests

**Files:**

- Modify: `src/agents/system-prompt.test.ts`
- Modify: `src/agents/openclaw-tools.set-thinking-level.test.ts`

**Step 1: Write the failing test**

Add assertions covering both model-aware paths:

- native-adaptive model:
  - `createOpenClawTools(...)` does not include `set_thinking_level`
  - `buildAgentSystemPrompt(...)` does not include `## Adaptive Thinking`
- non-native-adaptive model:
  - `createOpenClawTools(...)` still includes `set_thinking_level`
  - `buildAgentSystemPrompt(...)` still includes the adaptive-thinking guidance
  - the tool description still reflects intended `turn` vs `session` usage

**Step 2: Run test to verify it fails**

Run: `pnpm test src/agents/system-prompt.test.ts src/agents/openclaw-tools.set-thinking-level.test.ts`

Expected: FAIL because the tool is still exposed for native-adaptive models.

**Step 3: Keep the assertions narrow and model-specific**

Assert availability and section presence/absence, not full large prompt snapshots, so future prompt edits stay flexible.

**Step 4: Re-run the same tests if the failure reason is ambiguous**

Run: `pnpm test src/agents/system-prompt.test.ts src/agents/openclaw-tools.set-thinking-level.test.ts`

Expected: same targeted failure.

## Task 2: Gate tool registration and prompt visibility

**Files:**

- Modify: `src/agents/openclaw-tools.ts`
- Modify: `src/agents/system-prompt.ts`
- Modify: `src/agents/tools/set-thinking-level-tool.ts`
- Read/Reuse: `src/auto-reply/thinking.ts`

**Step 1: Write minimal implementation**

Gate `createSetThinkingLevelTool(...)` in `src/agents/openclaw-tools.ts` behind the existing native-adaptive capability helper so native-adaptive models do not receive the tool.

Then ensure the adaptive-thinking section still follows tool availability. If the current `availableTools.has("set_thinking_level")` contract already handles that, keep the prompt code minimal.

For non-native-adaptive models, keep the adaptive-thinking section rules:

- keep the current thinking level unless task complexity clearly changes
- use `turn` for one-off hard tasks
- use `session` only for lasting or user-requested changes
- raise thinking for debugging/design/subtle refactors/correctness-critical work
- keep default or low thinking for simple/mechanical work
- avoid repeated thrashing

**Step 2: Align the tool description**

Update the `set_thinking_level` description so the model sees the same intended use through the tool summary map when the tool is available.

**Step 3: Run test to verify it passes**

Run: `pnpm test src/agents/system-prompt.test.ts src/agents/openclaw-tools.set-thinking-level.test.ts`

Expected: PASS

**Step 4: Refactor only if needed**

If the prompt builder becomes noisy, extract a small helper inside `src/agents/system-prompt.ts`. Do not broaden scope.

## Task 3: Prompt regression verification

**Files:**

- Modify if needed: `src/agents/system-prompt.test.ts`
- Modify if needed: `src/agents/openclaw-tools.set-thinking-level.test.ts`

**Step 1: Run prompt-focused regression tests**

Run: `pnpm test src/agents/system-prompt.test.ts src/agents/pi-embedded-runner/system-prompt.test.ts src/agents/openclaw-tools.set-thinking-level.test.ts`

Expected: PASS

**Step 2: Run build verification**

Run: `pnpm build`

Expected: PASS

**Step 3: Scope check**

Verify the diff is limited to prompt wording, tool description, and tests. No runtime thinking mechanics should change in this slice.

Also verify `set_thinking_level` is hidden for native-adaptive models and visible otherwise.
