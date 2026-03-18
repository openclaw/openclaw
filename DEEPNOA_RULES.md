# Deepnoa Fork Rules

This file complements `AGENTS.md` for the Deepnoa fork.
It captures fork-specific rules that should stay stable even while `upstream/main` evolves.

## Git And Upstream Sync

- Keep `origin/main` close to `upstream/main`.
- Prefer merge-based upstream sync. Do not rebase the long-lived Deepnoa fork on top of upstream history.
- Create feature branches from the latest synced `main`.
- Branch names should use the `codex/` prefix.
- Before merging a feature branch, run the smallest meaningful build/test set for the touched area.

## Deepnoa-Specific Surfaces To Preserve

These are intentional fork differences and should not be dropped during upstream sync:

- Formspree inquiry intake webhook handling.
- `visitor.inquiry.detected` internal/public event contract.
- `Inquiry Intake` lightweight Control UI session visibility.
- `/bot` relay and public intake routing used by `deepnoa.com/bot`.
- Deepnoa scene / visitor linkage used by Deepnoa AI Office.
- Deepnoa NAS tools and custom skills.
- Sense worker remote execution integration.
- NemoClaw-style async job submit / poll / runner workflow.

If upstream changes touch these areas, prefer upstream's generic improvement first, then re-apply the Deepnoa behavior in a small follow-up patch.

## Sense Worker Rules

- OpenClaw acts as orchestrator. Sense acts as remote execution node.
- Default Sense base URL: `http://192.168.11.11:8787`
- Worker auth header: `X-Sense-Worker-Token`
- Health may stay unauthenticated. `POST /execute` must stay token-protected.
- Stable operator commands:
  - `pnpm sense:summarize`
  - `pnpm sense:draft`
  - `pnpm sense:analyze`
  - `pnpm sense:heavy`
  - `pnpm sense:heavy:review`
  - `pnpm sense:heavy:ollama`
  - `pnpm sense:heavy:nemo`
  - `pnpm sense:job-status`
  - `pnpm sense:job-poll`
  - `pnpm sense:nemo-runner`
- `401 unauthorized` must stay visible. Do not silently fallback on auth failure.
- Remote unavailable / timeout may fallback locally when the workflow already supports it.
- Structured result handling should preserve:
  - `worker_state`
  - `structured_source`
  - `normalized.summary`
  - `normalized.key_points`
  - `normalized.suggested_next_action`

## Async Job Rules

- `heavy_task mode=nemoclaw_job` should return async job envelopes, not inline pseudo summaries.
- Job states should remain understandable from OpenClaw:
  - `queued`
  - `running`
  - `done`
  - `job_not_found`
- `nemoclaw_runner.py` is the current external execution-node shim.
- Runner result schema should stay aligned with other structured task outputs:
  - `summary`
  - `key_points`
  - `suggested_next_action`
  - `raw_output`
  - `runner`
  - `exit_code`
- When the runner is processing a leased job, heartbeat must continue until complete or shutdown.
- If a runner stops unexpectedly, reclaim should happen on the Sense side rather than by OpenClaw guessing.

## Inquiry Intake Rules

- Public intake route: `https://deepnoa.com/bot/hooks/formspree`
- Internal gateway route: `POST /hooks/formspree`
- One webhook delivery should create one intake session.
- Public-safe event type: `visitor.inquiry.detected`
- Primary initial owner: `ops`
- Visible Control UI session label: `Inquiry Intake`

### Privacy Boundary

- Visible Control UI session must stay metadata-only.
- Do not expose raw email, phone, company, or full message body in public-safe surfaces.
- Keep raw inquiry details only in internal intake handling.
- Scene/public integrations should use only public-safe status and visitor trigger data.

## Control UI And Gateway Checks

After changes in gateway, hooks, or Control UI:

1. Run `npm run build`
2. Run `pnpm ui:build` when Control UI assets may be stale
3. Run targeted inquiry tests when intake behavior changes:
   - `npm test -- --run src/gateway/server.hooks.test.ts src/gateway/hooks.test.ts`
4. Run UI storage test when Control UI storage/session behavior changes:
   - `cd ui && pnpm exec vitest run --config vitest.config.ts src/ui/storage.node.test.ts`

## During Upstream Merge Conflicts

- Prefer upstream in generic platform code.
- Preserve Deepnoa rules in webhook intake, visitor/session visibility, and bot relay paths.
- If a conflict mixes upstream storage/session changes with Deepnoa-specific UI assumptions, align tests to the new upstream behavior instead of restoring the old fork behavior by default.

## Deployment Notes

- OpenClaw gateway on the Deepnoa host is expected on `127.0.0.1:19001`.
- Public bot-side relay may sit in front of the gateway; do not assume direct public access to the gateway port.
- If Control UI shows missing assets, rebuild with `pnpm ui:build` before investigating routing.
