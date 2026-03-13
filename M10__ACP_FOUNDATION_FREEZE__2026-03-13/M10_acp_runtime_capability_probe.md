# Mission 10 — ACP Runtime Capability Probe

## 1. Title

Mission 10 bounded ACP runtime-capability probe for provider-fairness equivalence.

## 2. Scope

Strict scope (only):

- exposed ACP runtime/backend controls relevant to provider/model throttling or fairness
- comparison against non-ACP provider-lane intent (`provider:<id>` lane-based fairness)

No runtime/source changes are proposed.

## 3. VERIFIED

- ACP runtime control interface exposes only:
  - `session/set_mode`
  - `session/set_config_option`
  - `session/status`
    via `AcpRuntimeCapabilities.controls` (`src/acp/runtime/types.ts`).
- Manager applies runtime config options from normalized runtime options as key/value pairs:
  - `model`
  - `approval_policy`
  - `timeout`
  - `backendExtras` passthrough keys
    (`src/acp/control-plane/runtime-options.ts` and `src/acp/control-plane/manager.runtime-controls.ts`).
- ACP manager concurrency controls are session-scoped:
  - per-session serialization via `SessionActorQueue`
  - max concurrent ACP runtime sessions via `cfg.acp.maxConcurrentSessions`
    (`src/acp/control-plane/manager.core.ts`, `src/acp/control-plane/session-actor-queue.ts`).
- Active ACP backend registration path is `acpx` (`extensions/acpx/src/service.ts`).
- `acpx` runtime advertises capabilities:
  - controls: `session/set_mode`, `session/set_config_option`, `session/status`
  - no explicit `configOptionKeys` advertisement
    (`extensions/acpx/src/runtime.ts`).
- `acpx` runtime `setConfigOption` passes arbitrary key/value to backend command surface (`agent set <key> <value> --session ...`) without declaring provider-throttle-specific keys in OpenClaw-side code (`extensions/acpx/src/runtime.ts`).
- ACP operator surfaces expose `/acp model`, `/acp timeout`, `/acp permissions`, and generic `/acp set <key> <value>` (`src/auto-reply/reply/commands-acp/runtime-options.ts`).
- No exposed ACP control in inspected code directly maps to provider-keyed lane concurrency (`provider:<id>`).

## 4. LIKELY

- ACP offers practical controls for model selection, timeout bounds, and permission policy, which can influence runtime behavior but are not direct provider-fairness controls.
- ACP session-level queueing and max-session limits are partial substitutes for global load control, not provider-scoped fairness parity.
- Generic `/acp set`/backend extras might allow backend-specific tuning, but provider-fairness equivalence cannot be inferred without explicit backend key contracts.

## 5. UNKNOWN

- Whether current ACP backend (`acpx`) supports hidden model/provider throttling keys not declared in OpenClaw-visible capabilities.
- Whether backend-side throttling semantics, if present, actually match non-ACP provider-lane fairness intent.

## 6. Exposed ACP runtime/backend controls

- `session/set_mode`: unrelated to provider fairness (execution mode control).
- `session/set_config_option` with `model`: partial substitute (model selection, not fairness scheduling).
- `session/set_config_option` with `timeout`: unrelated/indirect (latency bound, not provider fairness).
- `session/set_config_option` with `approval_policy`/permissions: unrelated (safety/approval semantics).
- `session/set_config_option` with arbitrary backend extras (`/acp set`): not proven (potential extension point without declared fairness keys).
- session actor queue serialization: partial substitute (per-session turn serialization only).
- `acp.maxConcurrentSessions`: partial substitute (global ACP runtime cap, not provider-scoped fairness).

## 7. Comparison to non-ACP provider-lane intent

- Non-ACP intent:
  - provider-scoped fairness/throttling via provider lanes (`provider:<id>`) and lane concurrency assignment.
- ACP exposed controls compared:
  - direct equivalent: none proven.
  - partial substitutes: session serialization + max concurrent ACP sessions + model selection.
  - unrelated: permission profile, timeout, runtime mode.
  - not proven: backend-extra keys as provider-throttle controls.

## 8. Equivalence verdict

ACP has no exposed direct equivalent to non-ACP provider-lane fairness in inspected control surfaces.

Current status:

- direct equivalent: unsupported/unproven
- partial substitutes: available (session-level concurrency and global session caps)
- provider-scoped fairness equivalence: not proven

## 9. Mission 10 implication

Mission 10 branch-equivalence mapping is complete with a bounded conclusion: ACP admission and session-level concurrency controls are present, but provider-fairness equivalence to non-ACP provider lanes is currently unsupported/unproven from exposed capabilities.

## 10. One bounded next action

Capture a formal Mission 10 closure note that marks ACP provider-fairness parity as an explicit gap/assumption for future reconciliation, with no implementation action in this mission.
