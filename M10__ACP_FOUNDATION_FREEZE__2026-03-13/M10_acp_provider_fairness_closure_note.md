# Mission 10 — ACP Provider-Fairness Closure Note

## 1. Title

Mission 10 closure note for ACP provider-fairness equivalence status.

## 2. Scope

Strict scope (only):

- closure classification for ACP branch-equivalence on provider fairness
- operational decision for Mission 10 on this point

No runtime/source behavior changes.

## 3. VERIFIED

- ACP admission-equivalent controls are mapped and directly evidenced:
  - ACP dispatch/agent policy checks
  - ACP session resolution gates before turn execution.
- ACP session/global concurrency-equivalent controls are mapped and directly evidenced:
  - per-session serialization (`SessionActorQueue`)
  - global ACP runtime session cap (`acp.maxConcurrentSessions`).
- Exposed ACP runtime/backend controls are generic (`set_mode`, `set_config_option`, `status`) and runtime options map to model/timeout/approval-policy/back-end-extras keys.
- No exposed ACP control was proven to provide provider-keyed fairness equivalent to non-ACP provider lanes (`provider:<id>`).

## 4. LIKELY

- ACP offers practical load/safety controls at admission and session/global concurrency levels.
- ACP provider-level fairness parity likely requires backend-specific throttling semantics not exposed as first-class controls in current inspected surfaces.

## 5. UNKNOWN

- Whether undocumented backend-internal keys or semantics can deliver provider-scoped fairness equivalent to non-ACP provider lanes.
- Whether any such backend behavior, if present, is stable and operationally reliable enough to treat as equivalence.

## 6. Branch-equivalence status

- admission:
  - mapped
- session/global concurrency:
  - mapped
- provider-level fairness:
  - unsupported/unproven from exposed controls

## 7. Mission 10 decision

Mission 10 records ACP provider-level fairness equivalence as unsupported/unproven from exposed controls and takes no implementation action on this point in Mission 10.

## 8. Deferred question for later missions

Do active ACP backends expose a documented, enforceable provider/model throttling control that can be validated as equivalent to non-ACP provider-lane fairness intent?

## 9. One bounded next action

Archive Mission 10 branch-equivalence outputs as baseline evidence and carry the deferred ACP provider-fairness question into the next reconciliation planning mission.
