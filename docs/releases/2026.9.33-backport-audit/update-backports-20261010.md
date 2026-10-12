# September extended-stable: update backports, 2026-10-10

This is the update-only follow-up to [preparation PR #168346](https://github.com/openclaw/openclaw/pull/168346), after its merge at `6d0da0e59422aeee017e1e9f0300f61f6c288796`. It retains the unpublished **2026.9.33** version and targets `extended-stable/2026.9.33`. No tag, package publication, release dispatch, or merge is part of this work.

## Search and source cut

All nine published versions requested were searched in open issue titles, bodies, and comments: **2026.6.33/.34/.35, 2026.7.33/.34/.35, and 2026.8.33/.34/.35**. The exact-version queries returned **85 hits / 74 unique open issues**, with no incomplete query results. Broader extended-stable, LTS, update, upgrade, restart, and migration queries supplemented attribution. A version mention is not evidence of an upgrade defect.

| Release month | `.33` hits | `.34` hits | `.35` hits |
| ------------- | ---------: | ---------: | ---------: |
| 2026.6        |          8 |         32 |          7 |
| 2026.7        |          2 |          1 |         18 |
| 2026.8        |          9 |          0 |          8 |

Main is pinned at `3f08ea94a3373110e46b8f18cc4790344af4ecb3`; the previous audit cut was `6d3f75a1baa71ea5f51db7150ba1eb2d6f067be1`. The inventory contains **5,653 commits**, including **467 since the prior cut** and **98 patch-equivalent** to the shipped baseline. The bounded update-owner screen dispositioned **234 older candidate rows** and **101 recent candidate/companion rows**. These are separate row sets, not a claim of complete semantic review of all mainline commits. The prior accepted audit cursor is not advanced.

The [machine-readable supplement](https://github.com/openclaw/openclaw/blob/backport/2026.9.33-updates/docs/releases/2026.9.33-backport-audit/update-backports-20261010.json) records the query coverage, all 74 issue classifications, selected upstream commits and contributor credit, and both bounded decision ledgers. It excludes raw reports, comments, private paths, and local execution transcripts.

## Upgrade reports and remaining gaps

| Report                                                                                          | Evidence                                                                                                             | Disposition                                                                                                                                                                                                           |
| ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [#152533](https://github.com/openclaw/openclaw/issues/152533)                                   | 6.35 → 9.5; legacy systemd definitions and backups prevent refresh while the updated Gateway remains healthy         | Unresolved protected-definition recovery contract. No blanket permission rewrite.                                                                                                                                     |
| [#136487](https://github.com/openclaw/openclaw/issues/136487)                                   | 6.34 → 8.1; completed child cannot wake its requester because the Gateway binding is missing                         | Cause remains unresolved; no fixing commit established.                                                                                                                                                               |
| [#122019 follow-up](https://github.com/openclaw/openclaw/issues/122019#issuecomment-5858538500) | 7.35 state → 9.6; first-pass shared-auth failure, repeat succeeds                                                    | Configured-target and schema-1 ordering repair from [#158584](https://github.com/openclaw/openclaw/pull/158584) is already represented in September. The exact shared-auth cause and feature tracker remain separate. |
| [#162085 follow-up](https://github.com/openclaw/openclaw/issues/162085#issuecomment-5979615525) | Historical schema-1 state → 9.8; large Windows database becomes sealed and hangs; same-machine 8.35 control succeeds | Unresolved seal recovery. This PR does not weaken the seal or qualify the large Windows scenario.                                                                                                                     |
| [#168159](https://github.com/openclaw/openclaw/issues/168159)                                   | 7.35 fleet state → main; blocked egress accumulates Codex discovery processes                                        | Backport timed-out catalog retirement. Native sibling-lease/process proof is not qualification of the entire 773-agent fleet.                                                                                         |
| [#168585](https://github.com/openclaw/openclaw/issues/168585)                                   | 7.35 fleet state → main; post-Doctor startup hits the 128-task admission cap                                         | The cap defect remains unresolved. The main-only plural admission recursion is absent on September; do not import that architecture merely to fix its own regression.                                                 |
| [#164433](https://github.com/openclaw/openclaw/issues/164433)                                   | Historical extended-stable driver refuses missing custom-plugin directories before candidate staging                 | Candidate changes cannot repair a driver that never stages them. Recipe [#164501](https://github.com/openclaw/openclaw/pull/164501) was open/unmerged at the audit cut.                                               |

[6.34 → 9.4 UI regression #154036](https://github.com/openclaw/openclaw/issues/154036) has no landed fixing PR and is outside this updater-only round. The [6.33 → 6.34 local manifest edit report](https://github.com/openclaw/openclaw/issues/117243#issuecomment-5244423311) concerns overwritten package edits, not loss of durable configuration. Third-party plugin versions, unrelated mentions, and downgrades to extended-stable were classified separately.

## Backport composition

Integrated selection: **21 groups / 24 upstream commits**, with narrow September-owner adaptations where a mechanical transplant would import newer architecture.

| Update contract                                                | Upstream source                                                                                                                                                                                  |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Canonical service-home overrides                               | [68834d2](https://github.com/openclaw/openclaw/commit/68834d21c435361630421e0cc24207df5d62719b)                                                                                                  |
| Explicit session-store agent selector                          | [8a04eb6](https://github.com/openclaw/openclaw/commit/8a04eb61ae46ee8e1728110e64573871efb6ab46)                                                                                                  |
| Snapshot publication on filesystems without birthtime          | [d4ce3b2](https://github.com/openclaw/openclaw/commit/d4ce3b2f33d41e8322a38c31430c9ce0e97a44c2)                                                                                                  |
| Preserve plugin state across registry retirement               | [6636dd6](https://github.com/openclaw/openclaw/commit/6636dd6709bdbace1b6b72c3a86ff664bbdec244)                                                                                                  |
| Legacy updater Doctor custody without a run ID                 | [725da12](https://github.com/openclaw/openclaw/commit/725da12cc31cbb923ca9884beddb316e3ca4ac32)                                                                                                  |
| Stopped/free Gateway rollback drain                            | [a7d90b3](https://github.com/openclaw/openclaw/commit/a7d90b3957226e12b2fe5d86bf557c01e618a589)                                                                                                  |
| Stable pnpm service launcher                                   | [9b46148](https://github.com/openclaw/openclaw/commit/9b46148b26804c213e23b11e3974278128ab1d2b)                                                                                                  |
| Backup and reuse without native vector loading                 | [058de57](https://github.com/openclaw/openclaw/commit/058de57ceb6da44c9f82c09b40e1b473f3647e6b)                                                                                                  |
| Backup metadata bound to verified snapshot bytes               | [0783e3f](https://github.com/openclaw/openclaw/commit/0783e3f28d4eb7bd3d38142a6b61975bcb972a66)                                                                                                  |
| Extended-stable package-upgrade tooling                        | [7a438dc](https://github.com/openclaw/openclaw/commit/7a438dc93ec0b80882cd40d217fd9d1508f8fea3)                                                                                                  |
| Retained stateless/inspection-only plugin confirmation         | [87abb5e](https://github.com/openclaw/openclaw/commit/87abb5e76f17b35d5d7b654cfdc3265744a6ca8e), [96d37e9](https://github.com/openclaw/openclaw/commit/96d37e971f033c3ee4aefa4bef2f80d616d2f969) |
| Refuse auto-restore after unattributed Doctor writes           | [65a3cce](https://github.com/openclaw/openclaw/commit/65a3cce3b9ba7778c06dcee3e4f0ef8845c5b619)                                                                                                  |
| Workspace avatar paths during update rehearsal                 | [80322af](https://github.com/openclaw/openclaw/commit/80322af5c7e5b606a172b9082756fd12f2151d1b)                                                                                                  |
| Monotonic Gateway readiness deadlines                          | [823fbf7](https://github.com/openclaw/openclaw/commit/823fbf745d4e79bba4871eda8e2ab2e58993cac8)                                                                                                  |
| Retained authority and untouched preparation recovery          | [9497527](https://github.com/openclaw/openclaw/commit/94975271e351ce67ac99bdde0d09826bbec4b757), [76beb56](https://github.com/openclaw/openclaw/commit/76beb568588720ed7d9cfafc4c8730637afe7532) |
| Truthful skipped/pending repair results                        | [688c0c5](https://github.com/openclaw/openclaw/commit/688c0c53e43599620e5917715106e5e2f4f7d245)                                                                                                  |
| Admit healthy recorded linked plugins                          | [468a57d](https://github.com/openclaw/openclaw/commit/468a57d3837b6df6e3a10231ecea35a54f3edfc6)                                                                                                  |
| Avoid bundled-plugin load-path churn                           | [76aabd1](https://github.com/openclaw/openclaw/commit/76aabd1052a37c743910212da9e2060f707c2074)                                                                                                  |
| Retire timed-out discovery without interrupting sibling leases | [e7ec72e](https://github.com/openclaw/openclaw/commit/e7ec72eb23c57265ea4980648e5762b2d59e70c9)                                                                                                  |
| Canonical SQLite validation keys across root aliases           | [efd0653](https://github.com/openclaw/openclaw/commit/efd06539cff04ea24c877b59909c504980a23cd9)                                                                                                  |
| Owned Doctor metadata and contribution lifetimes               | [01ead78](https://github.com/openclaw/openclaw/commit/01ead786dc19b1cf9921dfcf90917206d876dfc1), [310bce6](https://github.com/openclaw/openclaw/commit/310bce6a751791a9f61ce7a3bfcb3fd79653642b) |

Four of the original eleven proposals are covered by this update scope: canonical service home, explicit session-store agent selection, snapshot publication, and plugin-state preservation. The other seven proposals remain outside this round. The earlier preparation inventory and proof remain historical records rather than current shipping claims.

## Compatibility boundaries

- Preserve September's state schema **19**, agent schema **24**, receipt shapes, and existing opaque 64-hex database generations. No mainline immutable/new-schema migration framework is imported.
- Retire registries without treating restart as plugin removal. Stateless confirmation clears only admitted, available, non-migration debt and explicitly reports that no migration ran; required migrations and unavailable artifacts remain guarded.
- Snapshot capture preserves integrity, content hashes, source/published identity, and all three September validation stages. It does not require loading `sqlite-vec`; vector search still requires the extension.
- Untouched-preparation recovery retains installation identity, previous package/database identity, original command authority, journal generation, fence, and publication ownership checks. No completed-receipt archival/supersession framework is added.
- September retains lexical native-writer caches. Rollback drains matching captured physical identities through their original close owners, including an alias omitted from discovery after proof reuse; a retargeted link must not redirect cleanup onto an unrelated successor. Doctor transfers its retained metadata stack through a callable closure, preserving cleanup order on both supported Node versions.
- The early-request lifecycle fixture explicitly models shipped stable driver **2026.9.9**; production monthly-channel policy, assertions, and test budgets remain unchanged.
- The WAL digest-preimage change is excluded: an unchanged old driver and new candidate would otherwise disagree on existing opaque generations without a negotiated format.
- Legacy session delivery normalization is already implemented at September's import/accessor boundary. Ten native cases passed unchanged; the redundant source patch and temporary test additions were withdrawn.
- The compiled Vitest disk-budget entry fix is not established as a normal installed-updater defect; it remains separate tooling follow-up.

## Validation and qualification

This ledger is an authored implementation checkpoint. The coordinated PR's final-head evidence owns combined owning suites, static/type/dependency gates, fresh independent review, readable SDK/config comparison, full package build, packed published-driver proof, and hosted CI. Those results must be recorded against the committed candidate, not inferred from isolated proof or from the preparation PR.

| Isolated owning proof                                  | Observed result                                                                                  | Measured command wall          |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------ | ------------------------------ |
| Timed-out catalog, real owned protocol processes       | 1 baseline failure → 1 pass; sibling retained, both processes reaped                             | 81.517 s after                 |
| Catalog unit suite                                     | 22/22 after; earlier collection/undefined-fixture failures are not causal negatives              | 137.174 s                      |
| Frozen verified backup bytes                           | 2 failures / 6 guards → 8/8                                                                      | 46.365 s after                 |
| Final Doctor schema/refusal and native capture custody | 12/12, including two native default/borrowed cases; raw operator rows and receipt paths retained | 148.626 s                      |
| Floor-Node lifetime/service order                      | 5/5                                                                                              | 241.161 s                      |
| Recovery groups                                        | 45 distinct selected cases across joined proofs; final service replay 7/7                        | 171.944 s final service replay |

The restart-recovered integration run exercised all **483 originally selected owning files**; exercised is not a claim that its first run was green. Three inherited Doctor admission failures came from native launchd ancestry despite a private HOME, and one real surviving-registry failure exposed an omitted upstream retirement hunk. The Doctor fixture now supplies a unique nonexistent service label and retains its strict state/schema assertions: **17/17 passed in 99.335 seconds**.

The completed plugin restart adaptation includes both surviving-owner state preservation and the registered-close callback classifier. Before those production hunks, five callback modes failed while the memory-only and session-store controls passed. Afterward, **18 owning files passed, with 181 cases passed and one Linux-only case skipped on macOS**. The seven-case registered-close command measured **142.625 seconds** with one worker; its 17 sibling files measured **347.629 seconds** with native default scheduling. These real Gateway startup/close boundaries justify the cost. Tests retain admitted-work joins, fatal session-store and retained-resource failures, original deadlines, and September's final/cache modes. Shutdown fixtures use unique native identities and explicitly external supervision rather than the host service.

The earlier macOS Node/V8 crash and the review attempt terminated before any report remain failed or incomplete receipts, not passing gates. Final current-source review and static results belong to the coordinated PR evidence.

The intended npm inventory contains **101 packages**: `openclaw` and **100 publishable official plugins**, all already at **2026.9.33**. It is recorded in `update-backports-20261010.json`; this is not publication authority.

The maintained `published-upgrade-survivor` cell is planned with the actual **8.35 installed updater** and a tarball from the final committed **9.33** head. Its base recipe sets **stable-channel policy** before the old driver's explicit file-tag update. A pass would prove that representative driver/candidate transition, automatic migration before extra Doctor, state preservation, and restart/readiness/RPC behavior. It would **not** prove extended-stable dist-tag selection or all nine source versions. Shipped 8.35 refuses an explicit tag under extended-stable policy; that guard is unchanged.

No live models, paid provider proof, operator state, or managed-VPS service are used by that representative fixture. Service/authority boundary tests and simulated Windows paths are not native Windows/Linux service qualification.

Fixture collection errors, interrupted runs, and cold transformation time are retained as tooling/cost evidence, not successful behavior proof. Tests retain their observable assertions and budgets; fixtures use September's existing SDK and native owners.

PR readiness and release qualification are separate. Searching nine versions does not prove nine upgrade paths. A passing representative published-driver cell does not qualify Windows seal recovery, all historical plugin inventories, the 773-agent fleet, provider lanes, soak, or publication. The preparation branch remains unpublished.
