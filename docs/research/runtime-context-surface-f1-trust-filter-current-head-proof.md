# PR #85646 — trust-filter current-head real behavior proof

Generated: 2026-05-24T18:24:21.219Z
Branch: `feature/codex-skills-developer-instructions` (resolve HEAD via `git log -1 --format=%H -- docs/research/runtime-context-surface-f1-trust-filter-current-head-proof.md` to pin the captured commit SHA — the artifact intentionally avoids embedding the SHA because regenerating after an amend would otherwise loop).
Snapshot schema version: `2`

## Source fixtures

Temp workspace populated with one skill per source, each carrying a unique
synthetic marker string. No private paths, secrets, or MEMORY content.

| Source                  | Skill name         | Marker                                                     |
| ----------------------- | ------------------ | ---------------------------------------------------------- |
| `openclaw-bundled`      | `bundled-trusted`  | `BUNDLED-TRUSTED-MARKER-OK-FOR-DEVELOPER-LANE`             |
| `openclaw-workspace`    | `workspace-helper` | `WORKSPACE-USER-INSTALLED-MARKER-REFERENCE-ONLY`           |
| `agents-skills-project` | `project-helper`   | `PROJECT-AGENTS-MARKER-REFERENCE-ONLY`                     |
| `openclaw-managed`      | `managed-helper`   | `MANAGED-INSTALL-MARKER-REFERENCE-ONLY`                    |
| `openclaw-extra`        | `extra-helper`     | `EXTRA-DIR-MARKER-REFERENCE-ONLY`                          |
| workspace context       | (MEMORY marker)    | `USER-EDITABLE-MEMORY-MARKER-MUST-NOT-RIDE-DEVELOPER-LANE` |

## Built snapshot summary

| Field                                                    | Bytes | sha256-12      |
| -------------------------------------------------------- | ----: | -------------- |
| `prompt` (full availability list)                        |  1838 | `11449a4c52cf` |
| `trustedDeveloperPrompt` (bundled-only, developer lane)  |   601 | `a7031833fc6b` |
| `untrustedReferencePrompt` (non-bundled, reference lane) |  1605 | `11c379ff6687` |
| Reconstructed Codex turn-input wrapper                   |  2350 | `22e996bb5135` |

Skill count (eligible): `6`.

## Wire-level invariant: Codex `developer_instructions` skills lane

`developer_instructions` only carries the bundled (trusted) entry. No non-bundled marker reaches this lane.

| Assertion                                                                   | Result |
| --------------------------------------------------------------------------- | ------ |
| MUST contain `bundled-trusted`                                              | PASS   |
| MUST contain `BUNDLED-TRUSTED-MARKER-OK-FOR-DEVELOPER-LANE`                 | PASS   |
| MUST NOT contain `WORKSPACE-USER-INSTALLED-MARKER-REFERENCE-ONLY`           | PASS   |
| MUST NOT contain `PROJECT-AGENTS-MARKER-REFERENCE-ONLY`                     | PASS   |
| MUST NOT contain `MANAGED-INSTALL-MARKER-REFERENCE-ONLY`                    | PASS   |
| MUST NOT contain `EXTRA-DIR-MARKER-REFERENCE-ONLY`                          | PASS   |
| MUST NOT contain `USER-EDITABLE-MEMORY-MARKER-MUST-NOT-RIDE-DEVELOPER-LANE` | PASS   |
| MUST NOT contain `workspace-helper`                                         | PASS   |
| MUST NOT contain `project-helper`                                           | PASS   |
| MUST NOT contain `managed-helper`                                           | PASS   |
| MUST NOT contain `extra-helper`                                             | PASS   |

## Wire-level invariant: Codex per-turn user-input reference lane

Non-bundled skills remain visible to Codex via the per-turn user input under a non-authoritative `## OpenClaw User-Installed Skills (reference)` section. Bundled metadata is not double-listed here.

| Assertion                                                               | Result |
| ----------------------------------------------------------------------- | ------ |
| MUST contain `## OpenClaw User-Installed Skills (reference)`            | PASS   |
| MUST contain `workspace-helper`                                         | PASS   |
| MUST contain `WORKSPACE-USER-INSTALLED-MARKER-REFERENCE-ONLY`           | PASS   |
| MUST contain `project-helper`                                           | PASS   |
| MUST contain `PROJECT-AGENTS-MARKER-REFERENCE-ONLY`                     | PASS   |
| MUST contain `managed-helper`                                           | PASS   |
| MUST contain `MANAGED-INSTALL-MARKER-REFERENCE-ONLY`                    | PASS   |
| MUST contain `extra-helper`                                             | PASS   |
| MUST contain `EXTRA-DIR-MARKER-REFERENCE-ONLY`                          | PASS   |
| MUST contain `USER-EDITABLE-MEMORY-MARKER-MUST-NOT-RIDE-DEVELOPER-LANE` | PASS   |
| MUST NOT contain `bundled-trusted`                                      | PASS   |
| MUST NOT contain `BUNDLED-TRUSTED-MARKER-OK-FOR-DEVELOPER-LANE`         | PASS   |

## Legacy snapshot refresh (ClawSweeper P1b)

Legacy snapshot = pre-PR session storage that lacks `schemaVersion`, `trustedDeveloperPrompt`, and `untrustedReferencePrompt`. The `agent-command.ts` reuse path runs `isSkillsSnapshotSchemaOutdated()` against the persisted snapshot and forces a rebuild on `true`.

| Snapshot variant          | `isSkillsSnapshotSchemaOutdated` returns | Expected behavior                            |
| ------------------------- | ---------------------------------------- | -------------------------------------------- |
| Legacy (no schemaVersion) | `true`                                   | `true` → forced refresh on next session turn |
| Current (schemaVersion=2) | `false`                                  | `false` → reuse persisted snapshot           |

Coverage: `src/agents/skills/snapshot-hydration.test.ts`. Both the legacy `undefined` `schemaVersion` and the stale `schemaVersion < current` branches are pinned.

## Token-growth direction (no regression)

The developer lane (`trustedDeveloperPrompt`) is now strictly smaller than the original mixed-source `prompt`. The byte-stability / cacheable / no-history-replay properties of the developer lane carry forward unchanged (it is the same wire shape, just filtered). The reference lane (non-bundled subset of skills, plus the workspace context) rides the per-turn user input — the same lane it lived in before #85646 — so for non-bundled-heavy catalogs the per-turn user-history persistence cost matches the pre-#85646 baseline for that subset. Trade-off is disclosed in the PR Limitations section.

| Quantity                                              | Bytes |
| ----------------------------------------------------- | ----: |
| Full mixed-source `prompt` (legacy lane content)      |  1838 |
| Trusted developer lane (`trustedDeveloperPrompt`)     |   601 |
| Untrusted reference lane (`untrustedReferencePrompt`) |  1605 |
| Trusted + untrusted (sum)                             |  2206 |

Sum trusted + untrusted is slightly different from `prompt.length` because the two-lane render adds a per-lane header line that is not present in the unified prompt, while it removes the original unified header. Difference is bounded and accounted for above.

## What this proof does NOT cover

- No live OpenAI Codex backend rollout. The earlier 10-turn live benchmark in the PR body remains the wire-stability / cacheRead / token-growth proof for the bundled developer lane; this current-head artifact pins the structural invariants the live benchmark would re-establish (developer lane filtered to bundled, reference lane carries non-bundled, legacy snapshots force-refresh).
- No 50/100-turn long-session benchmark.
- Personal-source (`agents-skills-personal`) skills are exercised by `src/agents/skills/source.ts` (`agents-skills-personal` is in the same untrusted bucket as the other non-bundled sources). The trust-filter policy and the reference fragment apply identically to personal-source entries.
