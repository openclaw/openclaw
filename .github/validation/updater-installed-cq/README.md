# Temporary installed-updater C → Q verification

Validation branch only: `openclaw/updater-hosted-proof-20261110`. Do not merge this
one-off workflow into production. It runs only on same-repository PR opened or
synchronize events touching this directory or its workflow; there is no dispatch,
deployment, release, package publication, or write token. The parent owns review
and publication. Preparing these files does not claim a hosted run has happened.

## Exact input and runtime

- GitHub-hosted Ubuntu 24.04; exact Node 26.12.1, npm prefix installations only.
- Same-repository run 42717541806, artifact `package-under-test-42717541806-1`.
- C SHA-256: `8af1ea0fa5901638538863c602ae28674849322bd759ea80d936fe3c9824ac69`.
- C build metadata commit: `dd6c99776b161d441cb827f78d2b031addce6648`.
- The checksum, package name/version, build commit, exact Node version and bundled
  helper hashes are checked before package execution. The binding receipt records
  the actual checked-out harness commit, Actions identity and runtime/package data.
- Q is derived only with the bundled existing `first-hop-tarball` helper. Its
  seven-file import closure is unchanged; `tooling/PROVENANCE.json` records source
  commit, byte sizes and hashes. Only its source-location field was sanitized.

The standalone run/fixture/ledger scaffold was copied from the previously exercised
local proof. It imports no product runtime; it invokes the real installed C CLI.
No current checkout build, replacement updater or published older driver is used.

## Cases and evidence

All five cases run sequentially: success, relative traversal spelling, absolute
symlink chain, fatal canary-child exit after private registration, and cancellation after an observed
private registration/write. Each case gets fresh private state, config, home,
workspace, npm prefix/cache and temporary paths under a 0700 RUNNER_TEMP directory.
No global permissions or host service state are changed. Child environments omit
inherited credentials, auth configuration, NODE_OPTIONS and provider variables.
Registry dependencies still require public network access.

Success requires a real private plugin write observed externally, retained settings,
unchanged live asset/source/config policy, settled snapshot/Doctor ledger steps and
Q installed. Failure/cancellation require C retained and the real failed ledger;
cancellation is not successful if Doctor settlement cannot be observed. The run
returns nonzero for blocked or failed cases. No weak success fallback is added.

The failure fixture exits its isolated canary child with code 42 after recording the private write; an ordinary registration exception is intentionally isolated by the plugin loader and does not represent an updater failure.

The original command timeout is 900 seconds and the overall launch budget is 3600
seconds, unchanged. The workflow's finite 65-minute job deadline includes setup and
artifact upload; no repository-wide capacity, budget or routing setting changes.

Always-run collection uploads only the binding, summary, top-level command logs,
read-only ledger output and private-write receipts. Logs are capped at 1 MiB each,
summary at 8 MiB, private-write receipts at 64 KiB each and collected content at
64 MiB total. The collection manifest identifies truncation/omissions; the synthetic
token is redacted at export. Installations, SQLite files, tarballs, state/config,
homes and caches are excluded. Setup failure still leaves a workflow receipt.
A hard runner loss can prevent GitHub's always steps, so absence is not success.

## Limits and local checks

This is Node-only evidence, not Bun qualification, mid-copy cancellation,
arbitrary malicious-code sandboxing, a release, or a schema-upgrade proof. Q is a
version-distinct same-schema derivative. Helper/scaffold tests are not hosted
installed-updater evidence. Evaluate actual per-cell receipts after execution.

```sh
bash -n .github/validation/updater-installed-cq/run.sh
node --check .github/validation/updater-installed-cq/hosted.mjs
node .github/validation/updater-installed-cq/self-test.mjs
```

The self-test leaves a private local scratch directory beside itself. Do not commit
that output or any real-run files. The temporary validation workflow and harness
should be retired after the requested proof is reviewed; they are not production CI.
