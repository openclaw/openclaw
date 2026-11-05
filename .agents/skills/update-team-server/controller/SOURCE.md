# Controller reconciliation provenance

This reconciliation publishes the captured installed controller with reviewed
corrections. Peter authorized publication on November 5, 2026: “Publish
installed, reviewed.” Publication changes repository source only. It does not
install a controller, restart a service, or authorize deployment. The operator
still owns complete-closure adoption under [the existing procedure](README.md).

## Source evidence

The supplied read-only capture was taken on November 5, 2026 at 17:12 UTC. The
request attributes it to a retained-controller adoption on October 30, 2026 at
approximately 05:04 UTC. That adoption time is supplied provenance, not a new
observation made during this reconciliation. No deployment host or private
operations repository was accessed.

The comparison is pinned to main commit
`480d50305383bd283fe181cbe0677c9190a92307`. SHA-256 values are:

| File                           | Captured installed bytes                                           | Pinned main bytes                                                  |
| ------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `openclaw-release-deploy`      | `966e2eddbfdbf08059e6bed8977c266ca5f21dcaf4d9814026962d3f8ef84262` | `cb6bb8611cc09b597d743eb3884fff68c9c4d3d4e85e41784c6550f65205ec24` |
| `release-lib.mjs`              | `6b15327dde7353792b6b93b0fe06f721b896d7fa35f4fe50e8e87154cb973e2b` | `e77911bae3d42461e0fb67bf4275a5189598796bdae62ef4cf48369b9cf1adaf` |
| `disk-maintenance-launcher.py` | `c3ed27ebf9b0b512f7e4d1057e84affc8bdec890f60efda456f506b20aa22483` | `b329edaaaad7e48e69ac939f9e1b94ba5b80f05e428ff4461d364a4f221fa307` |

The supplied manifest has SHA-256
`10353b07b161b326c278a629694a3598a0c72c2eb7ed7e5ac7923481aa0805f4`.
It records matching deployed and pinned-main hashes for the other two members
of the four-file controller closure:

| File                              | SHA-256                                                            |
| --------------------------------- | ------------------------------------------------------------------ |
| `gateway-suspension-contract.mjs` | `dfdf7487710647a5ea5a7ae4f2edb06812b2b251cb2ec4880d791ad650a5e456` |
| `startup-profile.mjs`             | `329ed7455f00c92bc6d54ea475606b5f4c15a871f2205f3ea213189c8abff1c9` |

Those two files were verified against the supplied hash manifest; their deployed
bytes were not separately captured. The manifest also lists installed library
directory entries. A directory listing establishes presence, not content hashes
or provenance for the other listed programs. The maintenance launcher is an
adjacent caller, not a fifth member of the four-file adoption closure.

The request's earlier library hash,
`bcf2c45888726f75b612db269fa667c4f6fd11918b5fcf03e8b7974cdaf8e60c`,
matches [#187090](https://github.com/openclaw/openclaw/pull/187090), commit
`a968dc19900d`. Main subsequently gained the history-warning reason counts in
[#193110](https://github.com/openclaw/openclaw/pull/193110), commit
`5382559b66da`; the comparison uses the later pinned main bytes.

## Verified Git lineage and its limit

The original retained-repair/adoption implementation is in
[#187854](https://github.com/openclaw/openclaw/pull/187854), **closed without
merging**. Source commit `bd2cbace4acfb0f426310da8679bd26d3efc8eb2` was authored
on October 29, 2026 at 19:31:10 UTC. Branch head
`db743de409b136d87551fb45ed093f2333c13858` has the same tree and remained the
live head of `openclaw/retained-repair-controller` when checked. The PR was closed
at 19:47:03 UTC that day. The retrieved events and comments do not explain the
closure; no GitHub review records were returned.

That source contains `retainedAdoptionEntryGuard`, `retainedRepairLock`,
`retained-controller-fd9-gate-v1`, and
`retained-controller-fail-closed-bridge-v1`. All-local-ref history searches for
the entry guard and both protocol identifiers identified that commit. Human
contributor credit is recorded in the source commit and PR for @jalehman,
@fuller-stack-dev, @vincentkoc, and @RomneyDa.

The captured installed pair is newer than that PR's tree. The PR's script hash
is `8dd2a51041b84621f613864ad225e55ff1e234a9fce29b221bf96abc64ab307b`;
its library hash is
`6c265081e92da5a31bc743944fd2157116fc9634236e252a8d98ee36580031c3`.
Later captured changes include successive adoption and prestart retirement,
larger bounded witnesses, empty-session continuity, stdin transport for large
JSON, lock inheritance during sealing, and suspension/readiness corrections.
All-local-ref searches for `retainedAdoptionRetirePrestart` and
`retainedRepairAcceptanceGit` found no originating commit. Matching live branch
enumeration and open/closed PR text searches did not locate those later edits.
Their provenance is the supplied installed capture; no matching committed
source was established. This is a bounded search result, not a claim that no
other unpublished source exists.

The local Gitcrawl archive was consulted first but reported a last sync of
September 16, 2026. Live GitHub reads supplied current PR state. Open-PR searches
for the script filename, library filename, and `controller in:title` found no
matches. A search for `update-team-server` found only unrelated worker
provisioning PR #159178. PR search indexes text, so these searches are collision
checks rather than an exhaustive census of every open PR's changed files.

## Reconciliation decisions

The installed retained-repair and adoption owners are preserved, together with
their original tests from #187854 and focused regression coverage for the
reconciliation. The implementation binds replacement preparation, startup,
acceptance, original evidence, and complete-closure adoption to the existing
controller owner. It adds no configuration option or database schema migration.
The fixed `openclaw` project and `roboclaw` probe identifiers retain the observed
incident's acceptance contract already recorded in #187854; they are not a new
general-purpose discovery or configuration surface.

The repository intentionally differs from the installed capture in these areas:

- Preserve the ordinary deployment lock wait from
  [#173869](https://github.com/openclaw/openclaw/pull/173869). The captured
  entrypoint's early nonblocking flock exits before that wait can run. Acquire
  the existing lock at the parsed-command admission boundary, then perform the
  complete-closure gate before protected controller work.
- Preserve the maintenance caller's exclusive lock and inherited fd 9 from
  [#193269](https://github.com/openclaw/openclaw/pull/193269), commit
  `ae37d0fdc7d4`, including useful admission-error output. The captured launcher
  instead uses a shared lock and omits fd 9, which the captured library rejects.
- Preserve `KillMode=mixed` as well as `control-group` from
  [#190935](https://github.com/openclaw/openclaw/pull/190935), commit
  `630b7e1d23d1`. Both provide bounded cgroup cleanup; rejecting `mixed` would
  reintroduce the fixed operator-restart failure.
- Preserve history-warning reason counts from #193110 instead of reverting
  that diagnostic fix to the older captured implementation.
- Remove the unused `retainedRepairInstallGuard` and
  `retainedRepairAcceptanceGit` definitions and obsolete fragment instructions.
  Collapse identical profiling dispatch branches; both now retain fd 9 through
  the same bounded proof owner. The retained lifecycle and acceptance owners
  remain authoritative.

Expanded review also identified two installed failures at caller boundaries.
Retained repair now reads the typed systemd `ExecStart` command instead of
Linux `/proc/<pid>/cmdline`, which `process.title` overwrites. Executable,
generation, cwd, UID, cgroup, script, and port checks remain required. Steady
profiling's bounded release-validation subprocess now receives fd 9 and the
same controller namespace; it keeps its existing timeout and sanitized loader
environment. The profiling shell retains its read/mutation classification for
abnormal exits even though both operations share one dispatch implementation.
Regression proof covers all three paths.

Do not exempt read-only commands from the adoption entry gate as a blanket
optimization. The gate excludes readers of an incomplete controller closure,
not merely writes to runtime state. Even a read-only `audit-root` invocation
must enter through a consistent installed closure. Shared-reader admission
would require an explicit complete-closure protocol and caller proof; it is
not introduced by this reconciliation. The current maintenance caller retains
the exclusive lock and fd 9 for its proof calls.

## Qualification status

#187854 did not claim complete native qualification. Its recorded focused run
had 86 tests: 70 passed and 16 skipped. Its installed R4 native rehearsal was
incomplete, and it retained earlier continuation/custody failures. Those
historical results are provenance, not current passing evidence. The old tests
do not by themselves prove the later captured successive-adoption and
prestart-retirement paths.

The reconciliation PR records current focused proof, independent review,
measurements, and exact-head CI. Added regressions exercise actual fd-9
contention and stale-script exclusion, successive adoption, and a 4,097-session
witness larger than 1 MiB. Owner measurements cover the completed adoption
gate and read-only root audit; those operations do not access agent databases
or workspace trees. They do not establish full lifecycle performance on btrfs.
No live adoption or deployment acceptance is claimed.
