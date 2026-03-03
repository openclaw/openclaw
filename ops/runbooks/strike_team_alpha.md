# Strike Team Alpha (v1) — Runbook

## Purpose

Prove multi-agent coordination works with hard role definitions, model pins, and deterministic smoke that FAILS LOUDLY on drift.

## Team Roster (agent ids + expected pins)

- Captain: `main` -> `openai-codex/gpt-5.3-codex`
- Implementer: `exec-02` -> `openai-codex/gpt-5.3-codex`
- Reviewer: `president-a` -> `anthropic/claude-sonnet-4-6`
- SRE/Ops: `exec-04` -> `openai-codex/gpt-5.3-codex`
- Docs/Glue: `president-b` -> `google/gemini-2.5-pro`

## Preconditions (Gates)

- Gate 0: `~/bin/cyborg-run health` => PASS + `PIN_OK`
- Gate 1: gateway active + `:18789` listening
- Stop on: provider/model mismatch, auth errors (401), real rate-limit text, or masked fallback behavior.

## How to run

```bash
cd ~/openclaw-workspace/repos/openclaw
KEEP_TMP=1 ops/scripts/alpha_smoke.sh
```

## PASS criteria

- 5x `[alpha_smoke][OK] role=... pinned=.../...`
- Final line: `[alpha_smoke][PASS] 5/5 roles ok; provider/model pinned per role; no error patterns detected.`

## Receipts

- With `KEEP_TMP=1`: `/tmp/cc-alpha-<run_id>-*.json` and `*.out`

## Rollback

- Revert repo files via git; config rollback via latest `/home/spryguy/.openclaw/openclaw.json.bak.*` then restart gateway.

## One-command GO/NO-GO

```bash
cd ~/openclaw-workspace/repos/openclaw
KEEP_TMP=1 bash ops/scripts/gate.sh
```

## Reviewer Determinism Guard

- `alpha_smoke.sh` supports `ALPHA_REVIEWER_AGENT` override (default `president-a`).
- Reviewer checks are deterministic token checks; `HEARTBEAT_OK` triggers one hard retry and still FAILs if token mismatches.
- During smoke, any provider/model mismatch is FAIL.

## Gate Archive Contract

- `ops/scripts/gate_archive.sh` archives receipts **only on full PASS** (`health PASS+PIN_OK` and `alpha_smoke PASS 5/5`).
- Any FAIL path exits non-zero and writes **no** ledger archive files.
