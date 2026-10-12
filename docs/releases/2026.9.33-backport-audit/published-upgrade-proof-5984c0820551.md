# Captured published-driver upgrade proof

This records the completed local native run for [candidate `5984c082055108778da28c67c6061feea115e71a`](https://github.com/openclaw/openclaw/commit/5984c082055108778da28c67c6061feea115e71a), not a hosted run or a release qualification claim. The [captured receipt](https://github.com/openclaw/openclaw/blob/backport/2026.9.33-updates/docs/releases/2026.9.33-backport-audit/published-upgrade-proof-5984c0820551.json) projects the native controller receipt, inner summary, package identities, and timestamped phase events. It omits credentials, host paths, diagnostic bodies, and full file inventories; hashes identify the original captured artifacts.

## Package and driver identity

| Input or result                   | Captured value                                                     |
| --------------------------------- | ------------------------------------------------------------------ |
| Published baseline                | `openclaw@2026.8.35`                                               |
| Candidate                         | Unpublished `2026.9.33`, explicit local tarball                    |
| Archive SHA-256                   | `a4590dc22083593fd5cfa891a28b92e65138bd9e339df82214640269ff5255d0` |
| Archive bytes                     | 114,974,720                                                        |
| Install mode / scenario / restart | `updater` / `base` / `manual`                                      |
| Native controller                 | `node scripts/test-docker-all.mjs`, exit 0                         |
| Run interval                      | 2026-10-12 04:18:23.186–04:24:02.301 UTC                           |
| Lane / outer wall time            | 331s / 339.113s                                                    |
| Teardown                          | Joined                                                             |

The installed old CLI performs the update. The candidate and installed package identity captures have identical version, build stamp, and all **11,405 application payload entries** across `package.json`, `openclaw.mjs`, and `dist`. Installed dependencies are separately owned by npm; this is not a claim that `node_modules` is byte-identical. The maintained [payload identity assertion](https://github.com/openclaw/openclaw/blob/5984c082055108778da28c67c6061feea115e71a/scripts/e2e/lib/upgrade-survivor/worker-cell-package.mjs) checks this boundary.

## Existing-state execution evidence

These are captured native phase events, not proposed checks:

| Phase                                     | Status  | UTC timestamp |
| ----------------------------------------- | ------- | ------------- |
| Installed package identity                | Passed  | 04:23:01.637  |
| Missing load path after update            | Passed  | 04:23:01.708  |
| Automatic migration / survival assertions | Passed  | 04:23:01.877  |
| Prepublish plugin requests                | Passed  | 04:23:04.578  |
| Standalone Doctor                         | Started | 04:23:04.665  |
| Standalone Doctor                         | Passed  | 04:23:27.889  |
| Missing load path after Doctor            | Passed  | 04:23:31.360  |
| Survival assertions after Doctor          | Passed  | 04:23:31.517  |
| Gateway startup                           | Passed  | 04:23:57.950  |
| Gateway probes                            | Passed  | 04:23:58.201  |
| Gateway status RPC                        | Passed  | 04:23:58.956  |
| Missing load path at readiness            | Passed  | 04:23:59.032  |

The first survival assertion precedes standalone Doctor, so a later repair cannot conceal a missing updater migration. The maintained [survival assertions](https://github.com/openclaw/openclaw/blob/5984c082055108778da28c67c6061feea115e71a/scripts/e2e/lib/upgrade-survivor/assertions.mjs) verify the seeded config and existing state; the [run owner](https://github.com/openclaw/openclaw/blob/5984c082055108778da28c67c6061feea115e71a/scripts/e2e/lib/upgrade-survivor/run.sh) records their ordering. Missing-plugin configuration bytes remain preserved after update, Doctor, and readiness. Candidate post-core exits 0 with advisory warnings, not a warning-free result; warning reasons are retained in the receipt.

Selected verbatim terminal output from the completed lane:

```text
==> upgrade-survivor:update-candidate
Updating baseline openclaw@2026.8.35 to target tarball:file:/tmp/openclaw-current.tgz (2026.9.33)
==> upgrade-survivor:installed-package-identity
==> upgrade-survivor:assert-automatic-migration
==> upgrade-survivor:doctor
==> upgrade-survivor:assert-survival
==> upgrade-survivor:gateway-start
==> upgrade-survivor:gateway-probes
==> upgrade-survivor:gateway-status
Upgrade survivor Docker E2E passed baseline=openclaw@2026.8.35 scenario=base candidate=2026.9.33 updateRestartMode=manual idempotence=n/as startup=25s updateRestart=manuals healthz=1s readyz=1s status=1s.
==> [published-upgrade-survivor-2026.8.35] finished: 2026-10-12T04:24:02Z status=0
```

## Limits and later fixture-only repairs

This one cell authors stable policy for an explicit tarball. It does not prove extended-stable dist-tag selection, all nine baselines, automatic managed-service restart, a second restart, native Windows, root-managed VPS, mobile pairing, fleet capacity, live providers, or soak. Phase placeholders for inapplicable scenarios are not coverage. No merge, tag, publication, or release dispatch was performed.

The first exact-head hosted CI run exposed stale Doctor receipt assertions omitted from the existing donor transfer. The follow-up carries the relevant fixtures from [upstream `65a3cce3`](https://github.com/openclaw/openclaw/commit/65a3cce3b9ba7778c06dcee3e4f0ef8845c5b619): only genuinely unchanged fingerprints remain eligible; writes before or during maintenance do not. Production ownership and generation guards are unchanged. Fixture/evidence-only follow-ups do not relabel this archive as a pack of their later commit. Hosted CI and ClawSweeper remain separately tracked on the PR's current head.
