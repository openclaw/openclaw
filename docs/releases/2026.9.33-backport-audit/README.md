# 2026.9.33 preparation and backport audits

This directory preserves the original preparation audit merged in [PR #168346](https://github.com/openclaw/openclaw/pull/168346). The source bounds, proposal statuses, and proof below describe that historical preparation only.

The subsequently authorized [update-backport round](https://docs.openclaw.ai/releases/2026.9.33-backport-audit/update-backports-20261010) records the extended-stable upgrade issue search, additional mainline audit, compatible product adaptations, and remaining qualification gaps. It includes four update-related groups from the original eleven proposals; the other seven remain outside that round. No tag or package has been published.

## Original preparation snapshot

The preparation PR started from shipped **2026.9.9**, not a frozen or publishable release candidate. **Its eleven audit proposals were unapplied; one separately scoped, CI-required runtime repair was included.** It contained version metadata, the shipped-updater compatibility inventory, CI repairs, and the audit/proposal handoff below.

## Frozen source bounds

| Input                                              | Exact value                                              |
| -------------------------------------------------- | -------------------------------------------------------- |
| Shipped base                                       | `v2026.9.9` / `bcfc88812a35243893585dbeca87ca41b48272ca` |
| First September audit start (exclusive merge base) | `842697352d230da72571fdbf06440c325e7cc34c`               |
| Pinned main end (inclusive)                        | `6d3f75a1baa71ea5f51db7150ba1eb2d6f067be1`               |
| Main inventory                                     | 5,186 commits, including 28 merges                       |
| Stable patch-ID equivalents                        | 98; behavioral equivalence is not implied                |
| Non-equivalent rows                                | 5,088, each dispositioned                                |
| Snapshot                                           | 2026-10-10T08:07:39.116142+00:00                         |

There is no accepted September cursor. Prior October/August audits do not substitute for this bounded September scan. **The accepted cursor is not advanced.** Blocked and proposal rows carry forward their exact SHA, owner group, review/probe status and missing evidence.

The 253 September-only commits outside the merge base are why a clean pick or a patch-ID comparison is not a complete behavioral equivalence test.

## Measured review depth

- Subject/path summaries read: **2,952**.
- Complete production diffs manually reviewed: **268**.
- Actual single-commit no-commit applicability attempts recorded: **2,760**, comprising **2,758** current-production probes and **2** historical test-only probes.
- Blocked rows: **3,968**. Unread or unclosed deltas are not declared safe, ineligible or fully audited.
- Security reconciliation: **cleared**. Private advisory details are intentionally absent.

Mechanical inventory/probe completion, a cached diff, and a clean cherry-pick are not semantic review or release qualification. All 11 repair groups below remain proposals. The complete semantic audit is **incomplete**.

An `already-covered` row marked `mechanical-equivalence-only` is an empty probe, not a completed behavior review. Its unread production delta remains carry-forward.

## CI-required runtime repair

PR CI on `7606c0406765877713b2cf85e50bc59e115d52be` exposed a completed child follow-up failing with `replacement subagent source changed before commit`. Upstream [b725cc7](https://github.com/openclaw/openclaw/commit/b725cc7b27f64ae1b1cf72eccc0bd5959d982839) already addresses this defect: admit and persist the browser-cleanup claim before dispatch, then drain newly admitted predecessor writes before replacement. The September adaptation preserves the exact durable-source comparison, existing synchronous session-effect guards, duplicate-cleanup exclusion, and caller/source retirement checks; it does not import main's later session-effect or registry refactors.

The unchanged eight-file Gateway replays passed 30/30 on macOS and 30/30 on Linux/arm64, so those are not causal proof. Adapted real-worker controls fail four of twelve cases on unchanged production code, including the same replacement error. With the runtime repair, the twelve-file focused group passes 253/253 on each platform, including the original Gateway flow, duplicate browser cleanup, and caller/source retirement guards. Command wall times were 236.209 seconds on macOS and 256.643 seconds on Linux/arm64; all fourteen test/owner inputs were unchanged during each run. `ci-dispositions.json` records the source-bound proof. Required static/review results and hosted exact-head CI are owned by the preparation PR. Full release qualification remains pending.

This is a repair under the request to make PR CI pass, separate from the eleven proposal groups below. Frozen `commits.jsonl`, carry-forward rows, and review-depth counts describe the original audit snapshot; the later CI disposition supersedes b725cc7's original blocked/unreviewed status for this narrow adaptation only. The semantic audit remains incomplete and its accepted cursor is not advanced.

## Proposed repairs

| Group                                   | Public source                                              | Baseline defect / focused proof                                                                                                                      | Qualification gap                                                                                 |
| --------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Canonical service home / Doctor repair  | [160056](https://github.com/openclaw/openclaw/pull/160056) | Two actual Doctor failures; 67 path/service/Doctor tests pass with the source change                                                                 | Approved combined candidate and upgrade proof pending                                             |
| Approval source-config fence            | [160856](https://github.com/openclaw/openclaw/pull/160856) | Three unrelated-agent/wait failures; 49 authority tests pass; target/store/role revocations retained                                                 | Approved combined candidate/RPC qualification pending                                             |
| Idle compacted-session cold storage     | [157994](https://github.com/openclaw/openclaw/pull/157994) | One self-reference failure; 19 eligibility tests pass                                                                                                | Retained archive-budget candidate timeout remains unresolved; baseline one-case comparison passes |
| Explicit Doctor store-agent selector    | [156907](https://github.com/openclaw/openclaw/pull/156907) | Requested agent resolves to main; corrected selector test and three retained selector siblings pass                                                  | Approved combined Doctor/update qualification pending                                             |
| SQLite snapshot birthtime               | [164363](https://github.com/openclaw/openclaw/pull/164363) | ctime-derived birthtime control fails; minimal unsplit-owner adaptation passes 11 transfer + 11 Doctor backup tests                                  | Physical DSM / published-driver × candidate matrix not run                                        |
| Persistent plugin state across restarts | [164975](https://github.com/openclaw/openclaw/pull/164975) | Three shutdown ownership failures; minimal runtime adaptation passes 13 retirement + 16 cleanup tests                                                | Approved combined Gateway/update/package qualification pending                                    |
| Chinese embedding item-cap errors       | [136868](https://github.com/openclaw/openclaw/pull/136868) | Actual baseline policy fails at batch100; patched policy splits 100→50+50 and returns ordered output; invalid-input control stays fatal              | Boundary program only; full CLI/native qualification not run                                      |
| Compaction replay suffix rewrites       | [160895](https://github.com/openclaw/openclaw/pull/160895) | Five real sanitizer→Responses-wire cases lose checkpoints; repair preserves suffix rewrites and rejects changed covered prefixes                     | Boundary program only; native/package qualification pending; owner ships in `@openclaw/ai`        |
| Deep MCP result projection              | [160825](https://github.com/openclaw/openclaw/pull/160825) | Baseline recursive projection raises RangeError; repair returns a handled error without deep details; guest/success/non-RangeError controls retained | Boundary program only; native/package qualification pending                                       |
| Queue beside custom composers           | [147949](https://github.com/openclaw/openclaw/pull/147949) | Missing actionable queue row reproduced; two-UI-group native suite passes 103 tests                                                                  | Approved combined browser/package qualification pending                                           |
| Sign-in when Gateway stops responding   | [160954](https://github.com/openclaw/openclaw/pull/160954) | Disconnect notice/timeouts reproduce; same two-UI-group native suite passes 103 tests                                                                | Two new English keys still need canonical generated locale parity                                 |

These are material reliability/UX repairs to existing owners, not feature, SDK, schema or dependency upgrades. No security advisory backport is selected. `proposals.json` records exact ordered source SHAs, producers/callers, prerequisite dispositions, publication owners, no-surface-change alternatives and remaining gates.

Two source commits need minimal baseline adaptations. The unapplied, test-inclusive proposals are `proposals/snapshot-birthtime.diff` and `proposals/plugin-restart-state.diff`; hashes are in `proposals.json`. These are source-diff documents, not pnpm dependency patches. Blank patch-context lines omit whitespace padding; default `git apply` was checked against the baseline and produced the exact same staged trees as the tested patches. Do not import main's snapshot module split/state20 changes or its unrelated server-close callback exit policy.

## Observed proof and limits

- Four Gateway source regressions: **136 passed**. The combined wrapper plus separately reached Doctor fixture observed eight distinct files: **162 passed / one unchanged 120-second archive-budget timeout**. The exact baseline one-case comparison passed in 18.181 seconds; that does **not** clear or attribute the candidate timeout. The combined group is not green or release-qualified.
- Two UI proposals: **96 passed / seven failures** with test-only baseline controls; **103 passed** with the two source changes. JSDOM CSS warnings occur in both controls. This is not a browser screenshot or packaged UI qualification.
- Snapshot adaptation: **10 passed / one failure** before; **22 passed, exit0** after, including the Doctor backup sibling.
- Minimal restart adaptation: **10 passed / three failures** before; **29 passed, exit0** after, including retained persistent-store cleanup/failure controls.
- Runtime groups: six standalone actual-owner boundary executions assert expected baseline defects or patched recovery/negative controls. They are not native-suite, full-CLI or release-matrix passes.
- Snapshot after attempts initially stopped before tests on a compiler namespace-lease race during concurrent SDK output writes. The final successful after-proof used stable owned topology; earlier tooling failures are not product failures or discarded product-test retries.

No product source in this PR uses the eleven proposal adaptations. The final PR evidence owns preparation checks and exact-head SDK/config review; proof here describes disposable baseline experiments, not an already-approved staged product candidate.

Preparation checks passed for generated release metadata and the shipped-updater inventory. The complete changed postbuild fixture passed **143 tests**, with a measured single-worker command wall cost of **34.858 seconds**. An initial full build completed runtime/support-package bundling but stopped during unified declaration compilation because this audit's JSON files were added concurrently and its input-stability guard rejected the changed namespace. **No complete successful build is claimed.** The failed stage is atomic; it did not publish a partial declaration generation.

After freezing the audit inputs, the supported `qaRuntime` build passed in **75.638 seconds**: runtime compilation, local plugin assets, CLI import guards, all 13 postbuild phases including previous-release updater bridges, native loading of 53 built modules, and final build stamps. This runtime-only profile does not replace declaration, packaged UI or full release qualification. Final PR evidence owns the independent review and exact committed-head API/config comparison.

## Stable-maturity issue snapshot

All **3,132** all-state stable-maturity issues were fetched at 2026-10-10T06:27:18.196714+00:00; linked-source reconciliation was queried at 2026-10-10T06:34:34.476550+00:00. There are **501 open**, including **313 open P0/P1** issues. Current automated review text is available for **3,127**, but fetched is not manually reviewed.

`stable-issues.jsonl` records each issue's state/priority, review availability and exact in-scan references. `closing-pr` and merged `ClosedEvent` relationships are distinguished from mere cross-references or source/PR context in a body/review. A context reference is **not** claimed as a fix. Closed upstream is **not** claimed qualified for 9.9/9.33. No maintainer deferral is invented.

[Issue 168138](https://github.com/openclaw/openclaw/issues/168138) has a read current review and source-proven published9.9 snapshot defect, directly exercised by the narrow adaptation above. It is proposed, not shipped or closed. Other open high-priority issues retain baseline/fix/proof gaps for release-readiness reconciliation; labels alone neither select a backport nor prove a release blocker resolved.

## Publication and qualification ownership

`publication.json` inventories **four core npm packages and 95 official external plugins**, all aligned to 2026.9.33 / extended-stable. Their 9.9 baselines are published and the target versions were unused at the recorded registry queries. The core workflow requires AI, Gateway protocol and Gateway client tarballs before publishing root. An external-plugin-only inventory would miss the compaction owner in `@openclaw/ai`.

Bundled core plugins such as memory-core remain in the root npm artifact; absence from the external plugin plan does not mean unshipped. The updater compatibility record comes from the integrity-verified actual 9.9 tarball (build commit `bcfc88812a35243893585dbeca87ca41b48272ca`): **50 runtime chunks / 86 exports**, with eight historical records unchanged.

`ci-dispositions.json` records Docker promotion equivalence (50 retained tests pass), already-present survivor budgets, duplicate self-upgrade removal, existing source-independent admission/Doctor startup, the trusted installed-tree budget gate and unresolved mainline optimizer groups. No required scenario, guard, deadline, warning/fallback check or frozen-admission gate is removed or waived.

Preparation is not qualification. Before a candidate freeze: approve/apply the categorized set; close relevant carry-forward/companion gaps; revalidate due compatibility records and supported published-plugin migrations; generate release notes from the actual shipped set; compare readable SDK/config/plugin manifests on that exact head; and run current trusted full-release/package/Docker/published-driver qualification. Native app and ClawHub publication are outside this cut.

## Compatibility deadlines

The baseline compatibility inventory was checked as of **2026-10-10**: 112 records, 87 active, 38 already marked `removal-pending`. **19 due records are already `removal-pending`** and are preserved unchanged. Their existing status is not a new maintainer approval to defer removal. `publication.json` records each code, deadline, replacement and docs path; published-plugin readers, migration/removal conditions and explicit retention decisions remain pre-freeze work. Doctor's renewed removal deadlines remain 2026-11-29.

### Upcoming deprecations

| Code                                 | Deadline   | Replacement                                                                        | Documentation                                                                                                               |
| ------------------------------------ | ---------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `deprecated-session-store-beta5-api` | 2026-10-12 | `getSessionEntry(...)`, `listSessionEntries(...)`, and row-level session mutations | [Session and transcript migration](https://docs.openclaw.ai/plugins/sdk-migration#removed-session-and-transcript-file-apis) |

No compatibility surface is removed or renewed by this preparation PR. Recheck these deadlines against the actual release date before candidate freeze.

Pinned main's root version is still 2026.9.9. A later-month beta does not satisfy the extended-stable later-month production guard. **Publication is currently blocked by that guard; branch/PR preparation is allowed.** No guard bypass, release tag, publisher workflow or dist-tag write was performed.

## Ledger format and replay

- `audit.json`: exact bounds, measured counts and explicit incomplete/cursor/approval/freeze state.
- `commits.jsonl`: one row per frozen source commit. Each row carries the full immutable SHA, subject, file count, logical scopes and NUL-separated complete-path-inventory digest, plus review/probe/decision/group/gap state. Advisory identifiers in public source text/path scopes are redacted; altered subjects are marked. The source commit itself owns the full path/diff inventory; it is not duplicated into a multi-megabyte report.
- `stable-issues.jsonl`: one row per issue; no private comment bodies or advisory details.
- `proposals.json`: complete proposed-set closure and observed proof; none of these eleven proposals is applied.
- `carry-forward.json`: 30 blocked runtime groups, six companion requests, unknown publication owners and the early Gateway unread/reviewed-but-unclosed SHA sets. These remain unresolved, including mechanical-only equivalents.
- `publication.json` and `ci-dispositions.json`: coordinated artifact/qualification obligations.

Reason code `stable-patch-id-match` means patch equivalence only. `unreviewed-production-or-tooling-closure` means the complete production diff and September behavior/dependency proof remain open. `reviewed-but-unclosed-baseline-group` means a reviewed diff still lacks baseline/dependency/behavior/qualification closure. Blocked rows and proposed rows remain carry-forward; an accepted cursor may not advance just because their source identities were collected.

Rebuild the bounded source identities with `git rev-list --reverse --topo-order 842697352d230da72571fdbf06440c325e7cc34c..6d3f75a1baa71ea5f51db7150ba1eb2d6f067be1`. Inspect a row's complete changed paths and production delta with `git diff <sha>^1 <sha>`; merges use their first parent. Reproduce `pathInventorySha256` from the sorted UTF-8 paths returned by `git diff --name-only --no-renames -z <sha>^1 <sha>`, joined with NUL and followed by a trailing NUL. Actual no-commit probes ran only in detached task-owned baseline worktrees (merges use `-m 1`) and restored the shipped baseline after each attempt. Mechanical probes never supplied safety approval.
