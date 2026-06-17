---
title: "Sessions Diagnose Plan"
summary: "Execution guardrails for a read-only Gateway and CLI diagnosis surface for stuck or confusing OpenClaw sessions"
read_when:
  - Investigating stuck, busy, failed, or silently queued sessions
  - Adding Gateway protocol methods for session diagnostics
  - Changing diagnostic session state, active embedded-run tracking, or session CLI commands
planning_reference:
  - https://github.com/EveryInc/compound-engineering-plugin/blob/main/docs/skills/ce-plan.md
deepened: 2026-06-17
---

## Status

Deepened implementation plan.

This plan follows the `ce-plan` shape: it is a decision document with execution
guardrails, stable U-IDs, origin tracing, per-unit test scenarios, confidence
checks, and explicit scope boundaries. It captures what must be true after the
work lands. It intentionally does not prescribe exact implementation signatures,
shell choreography, or code structure beyond owner boundaries and touched
surfaces.

The repo-local plan path remains `docs/plan/sessions-diagnose.md` because this
checkout already uses `docs/plan/` for planning artifacts.

## Research and Deepening Record

- Repo and issue review: open session-state issues were grouped around busy
  session flags, stale active-run counters, false stuck-session recovery,
  misleading transcript diagnostics, stale native tool activity, and missing
  safe recovery prerequisites.
- Parallel agent review:
  - Protocol review found the schema must avoid unbounded blobs, path-bearing
    fields, and weak string domains for stable diagnostic codes.
  - Runtime review found fresh progress must not classify terminal sessions as
    live, and embedded diagnostics must prefer current key-resolved active runs
    over stale stored session ids.
  - CLI/docs review found selector ambiguity must fail clearly, not diagnose the
    first matching row.
- Planning reference: EveryInc `ce-plan` was used for stable U-IDs, origin
  tracing, per-unit tests, confidence/deepening, and guardrails-over-choreography
  structure.
- Confidence result: the plan is ready for execution when U1 through U7 are
  complete. The highest-risk sections are U2, U3, and U4 because they combine
  store state, live runtime state, and conservative classification.

## Origin Evidence

Live issue review on 2026-06-17 found a large open cluster around session-state
failures, stuck sessions, stale recovery state, and weak operator visibility.
Representative issues:

- [#92519](https://github.com/openclaw/openclaw/issues/92519): gateway restart
  can leave a session permanently busy, with inbound work accepted but no new
  model completion until `/new` or `/reset`.
- [#90240](https://github.com/openclaw/openclaw/issues/90240): a large Slack
  turn can leave the active embedded-run counter pinned, silently queuing later
  inbound messages until manual gateway restart.
- [#88870](https://github.com/openclaw/openclaw/issues/88870): stuck-session
  recovery can abort legitimately long active runs and report the misleading
  reason "Reply operation aborted by user".
- [#91505](https://github.com/openclaw/openclaw/issues/91505): stale-session
  diagnostics can misclassify app-agent sessions as "never started" when
  transcript resolution fails.
- [#87310](https://github.com/openclaw/openclaw/issues/87310): stale native
  tool-call activity can survive recovery/reset and poison later classifications
  for the same session key.
- [#86159](https://github.com/openclaw/openclaw/issues/86159): operators want a
  recovery ladder, but the prerequisite is reliable diagnosis so recovery does
  not steer, nudge, or abort the wrong state.

The issue pattern points to a first contribution that helps users and
maintainers directly: a read-only `openclaw sessions diagnose` command backed by
a typed Gateway method that explains why a session appears stuck before any
recovery action is attempted.

## Actors

- A1. Operator debugging a production gateway where a session appears busy,
  failed, silent, or wedged.
- A2. Maintainer triaging session-state issues from logs, JSON output, and
  reproduction artifacts.
- A3. Automation or dashboard code that needs structured diagnosis without
  scraping human log text.

## Requirements

- R1. Diagnose a target session by session key, session id, label, or latest
  likely candidate without mutating session state.
- R2. Return a stable JSON result suitable for CLI rendering, automation, and
  future Control UI use.
- R3. Combine stored session-row evidence with live process evidence: active
  embedded runs, command-lane state, diagnostic session activity, diagnostic
  session state, delivery state, and bounded transcript facts.
- R4. Classify common user-visible failure modes, including no target found,
  queued work without active run, live run with fresh progress, live run with
  stale progress, stale diagnostic activity, delivery pending, and missing
  transcript evidence.
- R5. Never include full prompts, assistant content, tool arguments, secrets, or
  local absolute paths in normal text or JSON output.
- R6. Make the CLI useful by default: concise summary first, findings with
  severity/confidence, evidence lines, and next safe checks.
- R7. Keep recovery actions, auto-clear behavior, and new config knobs out of
  this PR. Diagnosis must be safe to run repeatedly.
- R8. Reject ambiguous primary selectors and ambiguous label/session-id matches
  instead of picking a surprising target.
- R9. Keep the contract useful for future UI surfaces without making Control UI
  part of the first contribution.

## Key Flows

- F1. Operator runs `openclaw sessions diagnose --session-key <key>` and gets a
  concise diagnosis, evidence, and next safe checks for exactly that session.
- F2. Operator runs diagnosis without a selector and Gateway chooses the latest
  likely active or stale candidate, then explains why that candidate was chosen.
- F3. Automation calls `sessions.diagnose` and receives a schema-validated JSON
  result with stable codes and no raw transcript content.
- F4. Operator tries an ambiguous label or session id and receives a clear error
  asking for the exact session key.
- F5. Maintainer compares diagnostic output to logs, transcript metadata, and
  runtime state without the command mutating queues, lanes, stores, or recovery
  state.

## Acceptance Examples

- AE1. A session marked `processing` with no active embedded run produces a
  warning or error finding that explains queued or stuck state instead of
  telling the operator to abort blindly. Covers R1, R3, R4, R6.
- AE2. A long-running session with recent embedded-run progress is classified as
  active/fresh, not stale, so it does not reinforce the false-abort failure seen
  in #88870. Covers R3, R4.
- AE3. A session with stale diagnostic tool activity but no matching live work
  reports stale diagnostic evidence separately from live run state. Covers R3,
  R4.
- AE4. A missing or unresolved transcript does not collapse to "never started"
  when Gateway session activity or live run state proves work happened. Covers
  R3, R4.
- AE5. JSON output validates against the Gateway protocol schema and contains no
  transcript body text, secrets, or local absolute session-file paths. Covers
  R2, R5.
- AE6. An older Gateway that lacks the method returns a clear unsupported-method
  CLI error rather than an ambiguous transport failure. Covers R6.
- AE7. Multiple selector flags or multiple rows matching a label/session id fail
  before diagnosis so the operator does not inspect the wrong session. Covers
  R1, R8.

## Key Decisions

- D1. The first PR is diagnosis-only. Automatic recovery belongs in later work
  after classification is trusted.
- D2. The Gateway method is the canonical data source. The CLI calls Gateway
  rather than reimplementing local store and runtime inspection.
- D3. The method uses `operator.read` scope. It must not call recovery, abort,
  reset, lane release, store update, or compatibility repair helpers.
- D4. The result schema is bounded and typed. Do not expose unstructured
  `unknown` blobs for live runtime state.
- D5. Transcript use is fact extraction only. Counts, timestamps, source type,
  and existence flags are acceptable; raw content and local file paths are not.
- D6. Candidate resolution accepts at most one primary selector: `key`,
  `sessionId`, or `label`. Ambiguous `sessionId` or `label` matches fail instead
  of selecting the first row. With no selector, Gateway may choose the latest
  likely active or stale session and report why.
- D7. Classification is conservative. Recent live progress wins over stale
  diagnostic leftovers; stale evidence can be reported, but must not become a
  recovery recommendation.
- D8. The output is designed for humans first and automation second: readable
  CLI sections, stable JSON codes, and no hidden mutation.

## Scope Boundaries

In scope:

- A new read-only Gateway method for session diagnosis.
- A new CLI command that renders the Gateway result and supports JSON output.
- Small read-only runtime snapshot helpers where existing internals lack a safe
  diagnostic projection.
- Protocol/schema/docs/tests for the new command and method.

Out of scope:

- Recovery ladder, steer, nudge, abort, force-clear, or lane-release action.
- New diagnostics config surface or environment variable.
- Migration or compatibility repair of session stores.
- Channel-specific fixes for Telegram, Slack, Feishu, WhatsApp, DingTalk, or
  other transports.
- Control UI screen in the first PR, though the JSON contract should be usable
  by one later.
- Full transcript export. `sessions export-trajectory` remains the artifact
  workflow for deeper forensics.

## Dependencies and Order

- U1 must land before U2 and U5 because the handler and CLI validate against the
  protocol contract.
- U3 feeds U2 and U4 because classification needs read-only snapshots before it
  can compare stored state to live state.
- U4 can be developed inside U2, but its tests must prove the classification
  rules independently of CLI rendering.
- U5 depends on U1 and the Gateway method name/availability contract from U2.
- U6 should be updated after U1 through U5 have settled enough that docs do not
  overpromise behavior.
- U7 is the final proof unit and should not be considered complete until U1
  through U6 have their targeted tests.

## Implementation Units

- U1. **Protocol Contract**
  - Trace: R1, R2, R5, R8, F3, AE5, AE7.
  - Files: `packages/gateway-protocol/src/schema/sessions.ts`,
    `packages/gateway-protocol/src/schema/protocol-schemas.ts`,
    `packages/gateway-protocol/src/schema/types.ts`,
    `packages/gateway-protocol/src/index.ts`, generated protocol outputs.
  - Guardrails: add `sessions.diagnose` params/result schemas with bounded
    diagnostic, live-run, lane, delivery, transcript, and recommendation shapes.
    Keep helper schemas private unless they are intentionally public API.
    Prefer literal unions for stable codes that downstream callers can match.
  - Test scenarios:
    - Happy path: valid params and a diagnosed result validate and are exported
      through the public protocol package. Covers AE5.
    - Edge: `tail` rejects lower and upper bound violations. Covers R2.
    - Failure: path-bearing fields, raw transcript strings, and arbitrary
      unknown blobs are not part of the public result contract. Covers AE5.
    - Integration: schema registry, method validators, TypeScript exports, JSON
      schema generation, and Swift model generation include the new method.

- U2. **Gateway Read-Only Handler**
  - Trace: R1, R2, R3, R4, R5, R8, F1, F2, F3, F4, F5, AE1, AE4, AE7.
  - Files: `src/gateway/server-methods/sessions.ts`,
    `src/gateway/methods/core-descriptors.ts`,
    `src/gateway/server-methods.ts`, adjacent Gateway method tests.
  - Guardrails: implement `sessions.diagnose` as a read-only projection over
    existing store rows and live snapshots. Do not reuse helpers that can mutate
    legacy keys, repair stores, abort runs, release lanes, or rewrite state.
    Register the method consistently in descriptors, lazy method lists,
    advertised methods, and method scopes.
  - Test scenarios:
    - Happy path: explicit session key resolves the intended row and returns a
      diagnosed result with session, live, finding, evidence, and next-check
      sections. Covers AE1.
    - Edge: no selector chooses a likely active or stale candidate and reports
      the selection reason. Covers F2.
    - Edge: session-id and label selectors handle zero, one, and ambiguous
      matches without cross-agent guessing. Covers AE7.
    - Failure: invalid params return protocol validation errors, and not-found
      results do not claim transcript evidence was checked. Covers AE4.
    - Integration: Gateway advertises `sessions.diagnose`, lazy loading has a
      handler, and `operator.read` scope is sufficient.

- U3. **Runtime Diagnostic Snapshots**
  - Trace: R3, R4, R5, F5, AE2, AE3, AE4.
  - Files: `src/gateway/server-methods/session-active-runs.ts`,
    `src/agents/embedded-agent-runner/run-state.ts`,
    `src/logging/diagnostic-session-state.ts`,
    `src/logging/diagnostic-session-activity.ts`, adjacent tests under
    `src/gateway/`, `src/logging/`, and `src/agents/`.
  - Guardrails: expose small read-only snapshot helpers for active embedded
    runs, command lanes, diagnostic activity, and diagnostic session state.
    Preserve existing runtime ownership; do not add polling, caches, fallback
    state files, or state repair.
  - Test scenarios:
    - Happy path: active run snapshots include session linkage, terminal flags,
      and progress age without payload content. Covers AE2.
    - Edge: stale diagnostic tool activity is distinguishable from live active
      work. Covers AE3.
    - Edge: embedded diagnostics prefer the current key-resolved active session
      id over stale stored ids. Covers AE2, AE4.
    - Failure: missing transcript or session-file evidence does not erase live
      activity evidence. Covers AE4.
    - Integration: snapshot helpers are deterministic and side-effect free.

- U4. **Classification and Recommendations**
  - Trace: R3, R4, R6, R7, F1, F2, F5, AE1, AE2, AE3, AE4.
  - Files: `src/gateway/server-methods/sessions.ts`,
    `src/logging/diagnostic-session-attention.ts`,
    `src/logging/diagnostic-stuck-session-recovery.runtime.ts` for contract
    comparison only.
  - Guardrails: findings should be evidence-backed, severity-ranked, and
    conservative. Prefer "likely active" when there is recent progress. Prefer
    "stale evidence" when only diagnostic state is old. Never imply a mutating
    recovery action is safe unless the evidence proves the exact condition.
  - Test scenarios:
    - Happy path: live active run with fresh progress yields an info finding,
      not a stale-session error. Covers AE2.
    - Edge: queued lane plus no active run yields a warning or error with safe
      next checks. Covers AE1.
    - Edge: terminal sessions with old last-progress timestamps are not
      classified as active just because progress once existed. Covers AE2.
    - Failure: stale tool-call evidence after reset does not become the sole
      explanation when current live state disagrees. Covers AE3.
    - Integration: findings align with existing diagnostic attention and
      recovery terminology so maintainers can compare logs to command output.

- U5. **CLI Command**
  - Trace: R1, R2, R5, R6, R8, F1, F3, F4, AE5, AE6, AE7.
  - Files: `src/commands/sessions-diagnose.ts`,
    `src/cli/program/register.status-health-sessions.ts`,
    `src/commands/sessions-diagnose.test.ts`,
    `src/cli/program/register.status-health-sessions.test.ts`,
    `src/cli/program/routes.test.ts`.
  - Guardrails: add `openclaw sessions diagnose` with selectors, bounded tail,
    timeout, agent forwarding, and JSON mode. Require the Gateway method
    explicitly so older gateways fail clearly. Reject multiple primary selectors
    before making a Gateway call.
  - Test scenarios:
    - Happy path: text mode renders summary, findings, evidence, and next safe
      checks. Covers F1.
    - Edge: JSON mode emits the validated result without text decoration. Covers
      F3, AE5.
    - Edge: parent `--agent` and command-level options are forwarded correctly.
      Covers R1.
    - Failure: invalid `tail`, unsupported Gateway method, transport errors,
      ambiguous selectors, and not-found results have clear exit/error behavior.
      Covers AE6, AE7.
    - Integration: command registration keeps route lookup behavior consistent
      with other nested `sessions` commands.

- U6. **Docs and Operator Handoff**
  - Trace: R5, R6, R7, R9, F1, F3, F4, F5, AE5, AE6, AE7.
  - Files: `docs/cli/sessions.md`, `docs/cli/index.md`,
    `docs/gateway/protocol.md`.
  - Guardrails: document the command as read-only diagnosis, not as a recovery
    fix. Keep docs source-root-relative and do not include local user paths.
    Point users to `sessions tail`, `sessions export-trajectory`, and logs for
    deeper evidence.
  - Test scenarios:
    - Happy path: docs show common selectors, JSON mode, and timeout/tail
      options. Covers F1, F3.
    - Edge: docs explain selector exclusivity and ambiguous match failures.
      Covers F4, AE7.
    - Failure: docs state transcript bodies, secrets, and local paths are not
      printed. Covers AE5.
    - Integration: CLI index and protocol docs include the new command and
      method without promising automatic recovery.

- U7. **Verification and Review**
  - Trace: all requirements, flows, and acceptance examples.
  - Files: targeted tests above plus protocol generation, build, formatting, and
    lazy-boundary checks.
  - Guardrails: prove protocol shape, handler registration, CLI behavior,
    classification behavior, docs consistency, and no mutation calls before PR.
    Because this checkout may not be a normal git worktree, use explicit-file
    proof when local changed-file tooling cannot derive scope.
  - Test scenarios:
    - Unit: protocol validators, CLI command, route registration, snapshot
      helpers, and classification helpers pass targeted tests.
    - Integration: Gateway advertised methods and direct handler invocation pass
      targeted tests.
    - Static: protocol generated artifacts, TypeScript/build path, formatting,
      and import/lazy-boundary checks are current.
    - Review: no raw transcript content, secrets, local paths, mutation calls,
      recovery calls, or accidental config surfaces are introduced.

## Risks and Mitigations

- Risk: diagnosing from stale diagnostic state can repeat the same false
  positives reported by users.
  - Mitigation: always compare diagnostic state against live active-run and lane
    snapshots, lower confidence when evidence conflicts, and prefer active/fresh
    classifications when current progress exists.
- Risk: a helpful command becomes a hidden recovery API.
  - Mitigation: no mutating actions, no config knobs, `operator.read` scope
    only, and docs that frame the feature as diagnosis.
- Risk: JSON output leaks user content or local machine paths.
  - Mitigation: schema-level bounded fields, path-free runtime snapshots, and
    tests that reject path-bearing public result fields.
- Risk: Gateway method registration is incomplete.
  - Mitigation: test descriptors, lazy method loading, advertised methods,
    method scope, and required-method CLI fallback.
- Risk: classification appears more certain than evidence allows.
  - Mitigation: include severity and confidence; use explicit evidence lines
    and safe next checks instead of definitive recovery advice.
- Risk: selector convenience sends an operator to the wrong session.
  - Mitigation: reject multiple selector flags and ambiguous label/session-id
    matches; require session key when identity is unclear.
- Risk: generated protocol artifacts drift from handwritten schema.
  - Mitigation: regenerate JSON schema and Swift models before PR proof.

## Planning-Time Questions

No blocking planning questions remain for the first PR.

Resolved planning fork: the feature is a diagnosis surface, not recovery
automation. Recovery ladder work can follow once this command can reliably
identify stale, active, queued, and missing-evidence states.

## Implementation-Time Questions

- Exact finding codes may change during implementation, but the final set must
  map cleanly to acceptance examples AE1 through AE7.
- The handler can reuse existing session list or describe helpers only where
  they are side-effect free; any helper that mutates legacy state or repairs
  stores must be avoided.
- If a test needs fixture transcript facts, prefer minimal synthetic facts over
  raw prompt or assistant body strings.
- If generated protocol artifacts expose a wider public shape than intended,
  narrow the schema first rather than filtering only in CLI text rendering.

## Handoff Notes

- Start with U1 and U3 in parallel if using agents with disjoint ownership.
- Use U2 as the integration point, then U4 to harden classification behavior.
- Keep U5 and U6 honest by treating CLI text and docs as projections of the
  Gateway contract, not independent truth.
- Do not mark U7 complete until generated protocol artifacts and targeted tests
  prove the handwritten schema, Gateway handler, CLI command, and docs agree.
