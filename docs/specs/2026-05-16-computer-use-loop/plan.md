# Plan — Computer-use loop with high-res vision

## Approach

Layer a `computer_use` aggregate tool over the existing browser, canvas, and screen.record primitives. Inputs are screenshots taken at native resolution (capped at Opus 4.7's 2576px ceiling) and the model emits coordinate-based actions that the aggregator translates into `browser.click(x,y)` / `browser.type(text)` / `node.invoke({system: "click",...})`. Capability gating in `src/agents/model-catalog.ts` keeps this off for models that don't support computer-use. The whole loop runs inside the existing Pi-embedded runtime so tool-policy, session state, and audit log are uniform with the rest of the agent.

## Steps

1. Add `src/media/image-ops.ts` resolution mode: when the active model supports hi-res input, skip the current downscale step and only enforce the 2576px ceiling.
2. Add `src/agents/tools/computer-use.ts` — Anthropic computer-use tool schema (`screenshot`, `left_click`, `right_click`, `mouse_move`, `type`, `key`, `scroll`, `wait`). Dispatch into the underlying tools.
3. Wire DPR + coordinate normalization in `src/browser/` and `src/canvas-host/` so the model's coord system maps to physical click coords correctly.
4. Add capability flag `supportsComputerUse` in `src/agents/model-catalog.ts`; advertise the tool only when true and operator opts in via `computerUse.enabled`.
5. Allowlist + denylist gates: `src/agents/tool-policy.ts` enforces `computerUse.allowedHosts` + `computerUse.allowedNodes`; navigation outside the list returns a typed tool error to the model.
6. Audit log: every action persists a JSONL row + a hashed screenshot path under `~/.openclaw/agents/<agentId>/computer-use/<sessionKey>/`. Reuse the existing logging redaction so typed passwords (heuristic: tool param marked `secret=true`) are not stored.
7. Wall-clock guard: per-action `30s` default, whole-loop default `10min`, both configurable; on hit emit a typed timeout that the model can read and recover from.
8. CLI: `openclaw computer-use replay <session>` to step through an audited trace; `openclaw computer-use status` to show active loops.
9. Docs: `docs/tools/computer-use.mdx` with the host-allowlist pattern and screenshot retention notes.

## Dependencies / order

- Step 1 (hi-res image pipeline) blocks step 2.
- Step 4 (capability flag) blocks step 2 surfacing.
- Steps 5–7 (policy + audit + timeouts) must all land before turning the feature on by default for any operator.
- Step 8 (replay) and 9 (docs) follow.
