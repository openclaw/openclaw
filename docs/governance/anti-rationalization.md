# Anti-Rationalization Catalog (RI-011)

**Status:** seed catalog, v1 — 2026-04-12
**Engine:** `src/agents/governance/rationalization-engine.ts`
**Rules:** `src/agents/governance/rationalization-rules.json`
**Wire point:** `src/agents/pi-tools.before-tool-call.ts::runBeforeToolCallHook`

## What this is

OpenClaw's agent runtime inspects every tool call for common **rationalization patterns** — the excuses AI agents produce to skip verification steps — and blocks or warns when one matches. This shifts OpenClaw from "trust the agent" to "verify the agent" without requiring humans to review every single action.

Each rule has:

- **id** — stable identifier used in logs and telemetry
- **category** — `testing | quality | reliability | security | data-safety | debugging | version-control | process | documentation | review`
- **severity** — `low | medium | high | critical`
- **pattern** — case-insensitive regex tested against recent assistant prose AND stringified tool-call params
- **rebuttal** — the response shown when the rule fires
- **action** — `warn | require_override | block`

## Actions

| Action | Effect |
|---|---|
| **warn** | Logs once per (rule × session). Tool call proceeds. Telemetry captured. |
| **require_override** | Blocks the tool call. Caller can explicitly pass `requireOverrideBlocks: false` to the engine if an override justification has been captured (e.g. an MC admin button). |
| **block** | Blocks unconditionally. Cannot be bypassed without editing the rule catalog. |

## Current rules

### Testing
- **skip-tests-later** (`warn`) — "I'll add tests in the next iteration" and close relatives.
- **skip-tests-too-simple** (`warn`) — "Too simple to need a test."

### Quality
- **premature-optimization-later** (`warn`) — "Performance can come later."
- **this-is-temporary** (`warn`) — "We'll clean up this hack later."
- **skip-types-refactor-later** (`warn`) — "We can skip the type checks for now."

### Reliability
- **skip-error-handling-happy-path** (`warn`) — "Just handle the happy path for MVP."

### Security
- **skip-validation-trusted-caller** (`require_override`) — "Trust the caller, no need to validate."
- **skip-auth-check-internal** (`require_override`) — "Internal endpoint, no auth needed."

### Data safety
- **skip-migration-backup** (`require_override`) — Running a migration without a snapshot.
- **rm-rf-cleanup** (`block`) — `rm -rf /` or `rm -rf /*` or `rm -rf ..` style unconstrained deletes.

### Debugging
- **cant-reproduce-so-skip** (`warn`) — "Can't reproduce, moving on."

### Review
- **low-risk-skip-review** (`require_override`) — "Low-risk change, skip review."

### Version control
- **force-push-main-safe** (`block`) — Any `git push --force` targeting main/master/trunk.

### Process
- **disable-hook-to-commit** (`require_override`) — `--no-verify`, `skip-hooks`, `disable-hook` on commit/push.

### Documentation
- **skip-docs-self-evident** (`warn`) — "Self-explanatory, no comment needed."

## How to add a new rule

1. Edit `src/agents/governance/rationalization-rules.json`.
2. Add an entry to the `rules` array:
   ```json
   {
     "id": "kebab-case-id",
     "category": "testing",
     "severity": "medium",
     "pattern": "(?:regex|with|alternatives)",
     "rebuttal": "What to do instead, one sentence.",
     "action": "warn"
   }
   ```
3. Add a unit test to `rationalization-engine.test.ts` that exercises the new pattern against both a true-positive and a near-miss (false-positive guard).
4. Run `npx vitest run src/agents/governance/rationalization-engine.test.ts` to confirm.
5. Update this document with the new rule.

## Future work

- **Community submissions:** The rule catalog will eventually accept pull requests from OpenClaw customers who encounter new rationalization patterns in the wild. For now, patterns are first-party only.
- **Rationalization metrics panel:** Block 3 (Mission Control) will render per-session, per-agent rationalization counts so admins can see which rules fire most often and tune thresholds.
- **Override audit trail:** When `require_override` rules are bypassed, the justification will be captured in a new `rationalization-overrides.json` store so compliance can review after the fact.
- **Context-aware matching:** The current engine uses stateless regex. Phase 2 may add AST-style checks for tool-call params (e.g. detect `rm -rf ~` or `git push --force-with-lease` variations that the current patterns miss).
