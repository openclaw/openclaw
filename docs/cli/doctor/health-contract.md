---
summary: "The detect/repair contract that doctor checks and plugin health checks implement"
title: "Structured health check contract"
read_when:
  - You are writing or converting a doctor check
  - You are adding a plugin-backed health check through the plugin SDK
---

This page describes the structured health check contract for check authors.
Operators do not need it to run doctor.

## Structured health checks

To inspect registry clone shape, run
`openclaw doctor --lint --only core/doctor/project-clone-shape --json`.
This check also runs in ordinary Doctor and `--lint --all`. Unreadable clones
produce a skipped-inspection warning without aborting the remaining checks.
Repair guidance removes all partial-clone filters, refetches from origin
(unshallowing only when needed), fetches missing objects by ID, clears promisor
settings and `extensions.partialclone`, then repacks. See the
[repair sequence](/gateway/doctor#11e-project-clone-shape) before running these
network and disk operations manually.

Modern doctor checks use a small split contract:

```ts
detect(ctx, scope?) -> HealthFinding[]
repair?(ctx, findings) -> HealthRepairResult
```

`detect()` powers `doctor --lint`. `repair()` is optional and only runs under `doctor --fix` / `doctor --repair`. Checks that have not migrated to this shape still use the legacy doctor contribution flow.

Repair contexts can carry `dryRun`/`diff` requests; repair results can return structured `diffs` (config/file edits) and `effects` (service, process, package, state, or other side effects), so converted checks can grow toward `doctor --fix --dry-run` without moving mutation planning into `detect()`.

`repair()` reports `status: "repaired" | "skipped" | "failed"` (omitted status means `repaired`). When repair returns `skipped` or `failed`, doctor reports the reason and skips validation for that check. After a successful repair, doctor re-runs `detect()` scoped to the repaired findings; if the finding is still present, doctor reports a repair warning instead of treating the change as complete.

A finding includes:

| Field             | Purpose                                                |
| ----------------- | ------------------------------------------------------ |
| `checkId`         | Stable id for skip/only filters and CI allowlists.     |
| `severity`        | `info`, `warning`, or `error`.                         |
| `message`         | Human-readable problem statement.                      |
| `path`            | Config, file, or logical path when available.          |
| `line` / `column` | Source location when available.                        |
| `ocPath`          | Precise `oc://` address when a check can point to one. |
| `fixHint`         | Suggested operator action or repair summary.           |

Modernized core doctor checks stay attached to the ordered doctor contribution that owns their human `doctor` / `doctor --fix` behavior. The shared structured health registry is the extension point: bundled and plugin-backed checks run after core doctor checks once their owning package registers them in the active command path. `openclaw/plugin-sdk/health` exposes the same contract for plugin authors.
