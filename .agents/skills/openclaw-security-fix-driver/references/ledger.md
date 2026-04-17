# Ledger

The ledger is a single JSON file on disk that stores the state of the whole campaign. Its purpose is to make the skill **idempotent** and **resumable**: every long-running step writes to the ledger, and restarting the skill always picks up where the last session left off.

Path:

```
.agents/state/security-fix-driver/ledger.json
```

Add `.agents/state/` to `.git/info/exclude` (not to `.gitignore`, per `CLAUDE.md` local-only-ignore rule).

## Schema

```json
{
  "version": 1,
  "campaign": {
    "startedAt": "2026-04-16T10:00:00Z",
    "rankLimit": 100,
    "lastRankedAt": "2026-04-16T10:05:00Z"
  },
  "issues": [
    {
      "number": 68123,
      "url": "https://github.com/openclaw/openclaw/issues/68123",
      "title": "Unauthenticated webhook signature bypass",
      "labels": ["security", "severity:high"],
      "invocationMode": "batch",
      "score": {
        "total": 24,
        "severity": 8,
        "exploitability": 5,
        "blastRadius": 5,
        "recency": 2,
        "surfaceSensitivity": 4
      },
      "surface": "gateway ingress",
      "stage": "merged",
      "handoff": null,
      "files": [
        "src/webhooks/verify.ts",
        "src/webhooks/verify.test.ts"
      ],
      "prUrl": "https://github.com/openclaw/openclaw/pull/68156",
      "prNumber": 68156,
      "branch": "fix/webhook-hmac-verify",
      "mergedSha": "abc1234567890abcdef",
      "mergedAt": "2026-04-16T16:22:00Z",
      "reportPath": ".agents/state/security-fix-driver/reports/68123.md",
      "gates": {
        "pnpmTest": { "ran": true, "passed": true, "filter": "src/webhooks" },
        "pnpmCheck": { "ran": true, "passed": true },
        "pnpmBuild": { "ran": true, "passed": true }
      },
      "notes": [],
      "history": [
        { "at": "2026-04-16T10:12:00Z", "stage": "queued" },
        { "at": "2026-04-16T11:03:00Z", "stage": "analyzing" },
        { "at": "2026-04-16T11:40:00Z", "stage": "fix-drafted" },
        { "at": "2026-04-16T12:15:00Z", "stage": "tested" },
        { "at": "2026-04-16T12:25:00Z", "stage": "pr-filed" },
        { "at": "2026-04-16T15:02:00Z", "stage": "review-requested" },
        { "at": "2026-04-16T16:22:00Z", "stage": "merged" }
      ]
    }
  ]
}
```

## State machine

```
queued
  └─> analyzing
        └─> fix-drafted         ──┐
              └─> tested          │
                    └─> pr-filed  │
                          └─> review-requested
                                └─> merged
                                └─> changes-requested ──> tested (loop)
                                └─> ci-failed ──────────> tested (loop)
                                └─> blocked
  └─> skipped        (disqualified, triage-only, or duplicate)
  └─> handed-off-ghsa (GHSA-class; driver does not own landing)
```

Terminal stages: `merged`, `skipped`, `handed-off-ghsa`.
Recoverable non-terminal: `blocked` (records reason, waits for human).

## `invocationMode` field

Each issue entry carries `"invocationMode": "batch" | "single-issue"` to record how the driver first picked it up. This is purely informational (metrics, audit) — the state machine and checkpoints are identical across modes, except that:

- `batch` entries were selected by Phase 1 and have a `pass1Score` / `pass2Score` split on the score object.
- `single-issue` entries were named by the user directly; their `score` is computed by the same rubric but there is no Pass-1/Pass-2 split.

If the user later asks the driver to absorb a single-issue entry into a batch (or vice versa), update the marker in place and append a history entry — do not duplicate the issue.

## Update contract

All writes must be atomic — the ledger is read by humans and by the driver between steps, so a torn write is a correctness bug. Rules:

- Always write via `scripts/ledger.py` which writes to a temp file in the same directory and renames on top of the ledger.
- Always append a new entry to `history` when changing `stage`; never overwrite history.
- Never delete entries. Use `stage: skipped` with a `notes` entry explaining why.
- Do not mutate `score` after the initial rank unless the user explicitly asks for a re-rank (which bumps `campaign.lastRankedAt`).

## Resume algorithm

On skill start:

1. Read the ledger.
2. Group issues by terminal vs in-flight stage.
3. For each in-flight issue, compute the next action:
   - `analyzing` → re-present root-cause (C2 gate)
   - `fix-drafted` → run gates (C3 gate)
   - `tested` → commit + open PR
   - `pr-filed` / `review-requested` → delegate to `$openclaw-pr-maintainer` for status
   - `changes-requested` / `ci-failed` → jump back to the fix loop
   - `blocked` → show the blocker and ask the user
4. Present the list to the user with: issue number, title, stage, next action, last-updated timestamp.
5. Ask which issues to continue, which to skip, which to retry.
6. For each selected issue, run the next action.

Resume must never:

- Reopen or reclose a GitHub issue silently
- File a second PR for an issue that already has an open driver-owned PR
- Push to an existing branch without confirming the branch is still the driver's
- Re-run `pnpm test` / `pnpm build` without surfacing the previous result first

## History and audit

Each stage transition adds `{ at, stage, by? }` to `history`. If the transition was triggered by a GitHub event (CI failure, review), add `cause` (`"ci"`, `"review"`, `"merge"`, `"human"`). This is the audit trail shown to the manager if they ask "when did issue N's PR go green?"

## Concurrency

The driver is single-threaded per session. Do not run two driver sessions against the same ledger simultaneously — the file-rename write is safe against torn writes, not against last-writer-wins races. The ledger's top-level `lockedBy` field is reserved for a future multi-session extension; for now, leave it absent.
