# Local Model Run Promotion Patchset

Date: 2026-04-12

## Goal

Define the minimum patchset that should be promoted from the canary recovery
work into canonical OpenClaw source.

Promotion candidates:

1. Patch 1: `infer model run --local` uses ephemeral session by default
2. Patch 2: session store and transcript fallback use a profile-local root

These two patches are semantic corrections. They are not performance shortcuts.

## Why These Two Patches Qualify

Both issues were:

- reproduced on `Orin-25`
- reproduced on `Orin-26`
- fixed independently
- revalidated with the same correctness matrix

That makes them node-independent promotion candidates rather than canary-only
workarounds.

## Patch 1

### Name

`infer model run --local` ephemeral session by default

### Before

Default local one-shot behavior could implicitly reuse the main session:

- reused `agent:main:main`
- reused prior transcript state
- allowed cross-turn contamination between otherwise unrelated capability probes

### After

Default local one-shot behavior becomes:

- stateless by default
- continuity only when `sessionId/sessionKey` are intentionally supplied

### Correct Contract

- one-shot smoke test / benchmark / capability probe:
  - stateless
- explicit conversation continuity:
  - opt-in

## Patch 2

### Name

Profile-local session/transcript persistence root

### Before

Persistence scope could split:

- store path under the active profile
- transcript fallback under global `~/.openclaw/...`

That violated the meaning of the active profile boundary.

### After

Both persistence artifacts follow the same profile/agent scope:

- session store
- transcript fallback

### Correct Contract

If the active local run uses profile `X`, then:

- the store path belongs to profile `X`
- the transcript path belongs to profile `X`

## Environment Preconditions

These are required to reproduce the canary validation, but they are not part of
the promotion patchset:

- `llama-server -c 16384`
- reserve downshift must actually reach precheck
- canary service overlay / profile-to-model alignment

## Explicitly Excluded From Promotion

The following must stay out of Patch 1/2:

- discovery short-circuit
- provider-runtime broad scan skip
- plugin-augment caller short-circuit
- env or synthetic auth discovery skips
- runtime plugin candidate reductions
- tools-disabled construction skip
- TTS hint skip
- silent-reply section skip
- timing/debug probes
- canary-only env-gated explicit reuse injection hooks

Reason:

- they were useful for canary debugging and performance reduction
- but they are bounded fast-path or recovery gates, not semantics corrections

## Expected Promotion Order

The clean promotion order is:

1. Patch 1: local one-shot session semantics
2. Patch 2: profile-local persistence root
3. documentation for baseline and promotion boundary

Performance fast-path work, if promoted later, should be handled as a separate
design/optimization stream.
