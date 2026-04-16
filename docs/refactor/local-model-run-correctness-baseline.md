# Local Model Run Correctness Baseline

Date: 2026-04-12

## Scope

This baseline captures the correctness semantics that were independently
reproduced on two remote canary nodes using the same local multimodal model
family.

Validated nodes:

- `Orin-25`
- `Orin-26`

This document is about semantics and persistence scope. It is not a performance
fast-path document.

## Closed Statement

The following statement is now closed on both canaries:

- `infer model run --local` default one-shot is stateless
- explicit reuse is opt-in
- persistence root is profile-local

## Promotion Scope

The promotion-candidate scope is only:

1. Patch 1: local one-shot session semantics
2. Patch 2: profile-local session/transcript persistence root

Environment preconditions used during canary validation:

- `llama-server -c 16384`
- reserve downshift must actually reach local precheck
- canary profile/config points to the local `llama.cpp` server

These are prerequisites for reproducing the canary validation, not promotion
patches by themselves.

## Verification Matrix

The same correctness matrix was used on both nodes:

- text only
- vision only
- mixed `vision -> text`
- explicit same-session reuse

Observed on both nodes:

- text-only: pass
- vision-only: pass
- mixed `vision -> text`: pass
- explicit same-session reuse: pass

## What Patch 1 Closed

Before correction, local one-shot model runs could behave like a hidden
long-lived session and silently reuse `agent:main:main`.

That was enough to permit cross-turn contamination, including text/vision
carry-over between otherwise independent capability checks.

After correction:

- local one-shot creates an explicit ephemeral session by default
- default one-shot calls do not silently attach to `agent:main:main`
- repeated text and mixed probes no longer inherit unrelated assistant output

## What Patch 2 Closed

Before correction, persistence scope could split:

- the session store could be profile-local
- transcript fallback could still land under the global `~/.openclaw/...` root

After correction:

- session store follows the active profile/agent scope
- transcript fallback follows the same profile-local sessions directory

This means one-shot local runs persist under the active profile boundary rather
than the global default root.

## Explicit Reuse Contract

Explicit reuse remains valid and is still supported.

When a caller intentionally supplies `sessionId/sessionKey`:

- the same transcript file is reused
- `hadSessionFile=true`
- `prePromptMessageCount > 0`
- persistence remains profile-local

The important semantics boundary is:

- default one-shot: stateless
- continuity: explicit opt-in

## Out Of Scope

The following canary work is intentionally excluded from the promotion baseline:

- provider/discovery short-circuit
- provider-runtime broad scan skips
- plugin-augment short-circuits
- env/synthetic auth discovery skips
- runtime plugin reductions
- tools-disabled construction skips
- TTS hint skip
- silent-reply workaround
- timing/debug probes

These were useful for canary diagnosis and performance reduction, but they are
not part of the promotion semantics.
