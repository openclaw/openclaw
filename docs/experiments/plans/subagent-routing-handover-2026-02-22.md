# Subagent Routing + Announce Handover (2026-02-22)

## Status

- Branch: `feat/subagent-complete-hook-event`
- Scope completed:
  - Main agent `sessions_spawn` now enforces explicit routing when task is ambiguous.
  - Main agent can infer target fleet agent for clear tasks (dev/research/codex/visionclaw/katman-social/gizem-asistan).
  - Announce pipeline now ignores synthetic transcript-repair tool output.
  - Prompt guidance updated: subagents must set `agentId` explicitly.

## Why this change

- Anonymous/implicit spawn from `main` was causing wrong worker selection and unstable pickup flow.
- Synthetic repair text (`missing tool result in session history ... transcript repair`) was leaking into completion announces.

## Files changed

- `src/agents/subagent-spawn.ts`
- `src/agents/subagent-announce.ts`
- `src/agents/openclaw-tools.subagents.sessions-spawn.allowlist.e2e.test.ts`
- `src/agents/subagent-announce.format.e2e.test.ts`

## Behavior after patch

1. `main` + missing `agentId` + ambiguous task:

- Returns `forbidden` with routing-required error.

2. `main` + missing `agentId` + clear coding/research/vision/social/persona task:

- Routes to inferred fleet agent (if allowed and known in config).

3. Announce output extraction:

- Skips synthetic transcript-repair lines.
- Keeps real tool output/assistant output for completion announce.

## Tests run

- `pnpm vitest run --config vitest.e2e.config.ts src/agents/openclaw-tools.subagents.sessions-spawn.allowlist.e2e.test.ts`
- `pnpm vitest run --config vitest.e2e.config.ts src/agents/subagent-announce.format.e2e.test.ts -t "ignores synthetic transcript-repair tool output and keeps real findings"`

Both passed.

## Mahmut runtime checklist (post-deploy)

1. Trigger ambiguous spawn from main (no `agentId`) and verify `forbidden` is returned.
2. Trigger coding task without `agentId`; verify child session key starts with `agent:dev:subagent:`.
3. Trigger research task without `agentId`; verify routing goes to `research`/`research-analyst`.
4. Confirm no outgoing announce contains `transcript repair` synthetic line.
5. Watch logs for 10-15 minutes and verify no `missing tool result in session history` text reaches user-facing replies.

## Known limits / next follow-ups

- Keyword inference is heuristic; improve with explicit fleet routing policy table if needed.
- If fleet ids differ across environments, keep `agents.list` canonical and aligned with allowlists.
- This patch does not change memory compaction policy; compaction/amnesia issues must be handled separately in memory pipeline/config.

## Handover note for Mahmut (copy/paste)

"Apply this branch head for spawn+announce stability. Main must not free-spawn anonymously anymore. If `agentId` is missing, route only when task is clear; otherwise fail fast. Also ignore synthetic transcript-repair tool output in announce extraction. After deploy, run the 5-step checklist above and report routing hit-rate + false-forbidden rate."
