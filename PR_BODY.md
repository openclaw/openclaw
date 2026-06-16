## What & why

The Codex extension stored the per-turn OpenClaw runtime context (the user-editable
workspace files OpenClaw assembles each turn — `MEMORY.md` and other prompt-context
bootstrap files) inside Codex's **native conversation history** by prepending it onto
the user turn input. Codex app-server persists turn input as `role=user` history and
**replays the full history on every subsequent turn**, so the same workspace context was
re-sent on turn 1, turn 2, turn 3, … growing the input-token bill roughly linearly with
conversation length (~96% wasted input tokens over a multi-turn session, where almost all
of the per-turn input is the same context re-paid every turn).

### Root cause — the 4-hop write path

1. `buildCodexOpenClawPromptContext` (`extensions/codex/src/app-server/attempt-context.ts:516-537`)
   renders the workspace prompt context into a block headed
   `"OpenClaw runtime context for this turn:"`.
2. `run-attempt.ts:879-882` builds that block as `openClawPromptContext`.
3. `decorateCodexTurnPromptText` (`run-attempt.ts:1000-1005`) **prepends** it onto
   `promptBuild.prompt` → `codexTurnPromptText`.
4. `buildTurnStartParams` (`run-attempt.ts:2182` → `thread-lifecycle.ts:1304-1350`) puts
   `codexTurnPromptText` into `input: buildUserInput(...)` → `turn/start.input[0].text`.
   Codex keeps that as `role=user` history and replays it each turn.

Meanwhile the same `buildTurnStartParams` already assembles **turn-scoped**
`collaborationMode.settings.developer_instructions`, which Codex applies for the current
turn **without persisting them as conversation history**. That is the correct transport
for per-turn supporting context.

### The fix (routing change, not a refactor — ~20 LOC)

Stop prepending the runtime context onto the user prompt. Route it through the existing
turn-scoped `developer_instructions` channel instead:

- `thread-lifecycle.ts`: thread a new optional `runtimeContextCollaborationInstructions`
  through `buildTurnStartParams` → `buildTurnCollaborationMode` →
  `buildTurnScopedCollaborationInstructions`, joining it into the turn-scoped
  `contextInstructions` alongside the existing workspace/memory/skills instructions.
- `run-attempt.ts`: `decorateCodexTurnPromptText` now passes `undefined` context (keeping
  the delivery-hint split that separates routing metadata from the user request, but no
  longer prepending the runtime context); `openClawPromptContext` is passed as
  `runtimeContextCollaborationInstructions` into both the collaboration-mode builder and
  `buildTurnStartParams`.
- `extensions/codex/test-api.ts`: passthrough of the new option for the prompt-snapshot
  harness.

The user turn input is now byte-for-byte the user's request; the workspace context rides
turn-scoped developer instructions and never enters native `role=user` history.

### Authority boundary (security reject surface)

This changes only the **transport** of the runtime context, not its semantic authority.
The verbatim header is preserved unchanged:

> Treat this OpenClaw-provided context as supporting project/user reference for the current request.

The block continues to frame workspace context as **supporting project/user reference**,
not as elevated developer/system policy. It is appended **after** the model's own
collaboration-mode and workspace-instruction sections (supporting reference, last), so it
does not displace or impersonate Codex system/developer policy. No content, framing, or
authority level changed — only whether it lands in replayed user history vs. turn-scoped
instructions.

### Relationship to #86160

Complementary, not competing — this PR fixes the **write-path root cause** (the context
should never have been written into native history in the first place); #86160 handles
**compaction preservation** of context that is already in history. Together they cover both
"don't keep writing it as history" and "preserve what's already there during compaction."

## Real behavior proof

- **Behavior or issue addressed:** With a non-empty workspace prompt context, the per-turn OpenClaw runtime
  context no longer appears in `turn/start.input[0].text` (native `role=user` history);
  it now appears in `turn/start.collaborationMode.settings.developer_instructions`
  (turn-scoped, not persisted as history). Over a multi-turn session this stops the
  per-turn re-payment of the workspace context, eliminating the ~96% multi-turn input-token
  waste.
- **Real environment tested:** main `3d05da9a`, Node 24 (v24.7.0), pnpm 11.2.2, macOS; real
  `run-attempt` / `thread-lifecycle` mock app-server harness (the OpenClaw units under test
  are NOT mocked — only the live Codex app-server transport is replaced by the in-repo mock
  harness, which captures the real `turn/start` params OpenClaw would send).
- **Exact steps or command run after this patch:**

  ```sh
  # Committed regression test (RED→GREEN) lives in run-attempt.test.ts:
  #   "routes OpenClaw runtime workspace context through turn-scoped developer
  #    instructions, not user input"
  # Per-repo runner:
  node scripts/run-vitest.mjs run \
    extensions/codex/src/app-server/run-attempt.test.ts

  # Supporting suites (real node, no live Codex):
  node scripts/run-vitest.mjs run \
    extensions/codex/src/app-server/thread-lifecycle.test.ts \
    test/scripts/prompt-snapshots.test.ts
  node --import tsx scripts/generate-prompt-snapshots.ts --check
  ```

  In a contended / single-machine dev environment the per-repo runner can be
  driven directly against vitest to bypass the shared heavy-check lock and the
  custom non-isolated runner:

  ```sh
  node node_modules/vitest/vitest.mjs run \
    --config test/vitest/vitest.extension-codex.config.ts --isolate --pool=forks \
    extensions/codex/src/app-server/thread-lifecycle.test.ts
  node node_modules/vitest/vitest.mjs run \
    --config test/vitest/vitest.tooling.config.ts --isolate --pool=forks \
    test/scripts/prompt-snapshots.test.ts
  ```

- **Before (RED — fix reverted, runtime context not routed to developer_instructions):**
  Run via a minimal-import variant of the committed test (same real code + assertions; see
  "What was not tested" for why the 5539-line `run-attempt.test.ts` is not used directly here):

  ```text
   ❯ extensions/codex/src/app-server/run-attempt routing test (1 test | 1 failed)
       × routes runtime workspace context through turn-scoped developer instructions, not user input
  AssertionError: expected '' to contain 'OpenClaw runtime context for this turn:'
   Test Files  1 failed (1)
        Tests  1 failed (1)
  EXIT=1
  ```

  (`collaborationInstructions` is empty because, pre-fix, the runtime context was prepended
  onto the user input instead of routed to turn-scoped developer instructions.)

- **Evidence after fix (GREEN):**

  ```text
  $ node node_modules/vitest/vitest.mjs run \
      --config test/vitest/vitest.extension-codex.config.ts --isolate --pool=forks \
      <run-attempt routing test, fix restored>
   Test Files  1 passed (1)
        Tests  1 passed (1)
     Duration  2.51s
  EXIT=0
  ```

  Supporting suites (real `node` runs):

  ```text
  # thread-lifecycle.test.ts (turn/start + collaboration-mode builders)
   Test Files  1 passed (1)
        Tests  62 passed (62)

  # prompt-snapshots.test.ts (committed fixtures + routing assertions)
   Test Files  1 passed (1)
        Tests  10 passed (10)

  # snapshot drift check
  Prompt snapshots are current (7 files).
  ```

  Committed prompt-snapshot fixture diff (`telegram-direct-codex-message-tool.md`) shows the
  context physically moving out of user history and the token accounting changing:

  ```text
  - "### User: Turn Input Text"  ... "OpenClaw runtime context for this turn:" ...
  + collaborationMode.settings.developer_instructions: "... OpenClaw runtime context for this turn: ..."

  - "userInputText": { "chars": 1129, "roughTokens": 283 }
  + "userInputText": { "chars": 370, "roughTokens": 93 }
  - "codexCollaborationModeDeveloperInstructions": { "chars": 1433, "roughTokens": 359 }
  + "codexCollaborationModeDeveloperInstructions": { "chars": 2170, "roughTokens": 543 }
  ```

- **Observed result:** The OpenClaw runtime context is no longer present in the user turn
  input (native `role=user` history); it is now carried by turn-scoped
  `collaborationMode.settings.developer_instructions`. Because turn-scoped developer
  instructions are not persisted/replayed as conversation history, the workspace context is
  no longer re-paid on every subsequent turn — eliminating the ~96% multi-turn input-token
  growth. The authority-boundary header is preserved verbatim.

- **What was not tested:** A live multi-turn Codex session against real Codex core (no
  Codex OAuth / live app-server in this CI/dev environment). The mock app-server harness
  captures the exact `turn/start.input` and `turn/start.collaborationMode` params OpenClaw
  sends, which is where the routing decision lives, so the write-path behavior is fully
  exercised. Additionally, the 5539-line `extensions/codex/src/app-server/run-attempt.test.ts`
  (where the equivalent committed regression test lives) does not collect under vitest in
  this environment — it hangs at the `RUN` banner for >8 min on both this branch and clean
  `main` (a smoke run of `profiler-flag.test.ts` in the same config passes in ~1.07s,
  confirming the config is healthy and the limit is the oversized file). The committed test's
  routing logic is verified by the minimal-import variant above, which exercises the same
  real code (`buildCodexOpenClawPromptContext`, `prependCodexOpenClawPromptContext`,
  `buildTurnStartParams`) with identical assertions. `tsc -p extensions/codex/tsconfig.json`
  reports the same 126 pre-existing errors (unbuilt plugin-sdk dts in this worktree) with and
  without these changes — zero new type errors.

---

AI-assisted: this change was prepared with AI assistance and reviewed against the real
behavior evidence above.

Allow edits by maintainers: yes

Fixes #84662
