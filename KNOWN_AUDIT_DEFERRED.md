# Known clean-audit deferrals

This file records documentation artifacts that were intentionally kept when a
cleanup pass requested explanation instead of deletion. It is public-facing and
should not contain private operator details.

## Blockers (deferred, not fixed)

- `apps/broker/README.md` — module-level README for the new Go
  PTY-WebSocket broker subproject. Go convention is one README per
  module, and this one documents the wire framing that
  `platform-context/api/runtime_proxy_service.py` consumes — the
  contract has to live somewhere.

- `docs/rockie-fork-surface.md` — public map of Rockie-owned fork prefixes and
  OpenClaw core patch groups that still need explicit justification.

- `docs/upstream-ancestry-repair.md` — public-safe proof note for the PR #99
  ancestry repair path. It records the proof branch and tree-equivalence checks
  without rewriting public `main`.

## Why we don't bypass with `CLEAN_BYPASS=1`

The docs above make the fork understandable to public readers and are part of
the open-source quality gate for Rockie's OpenClaw-derived tenant runtime.
