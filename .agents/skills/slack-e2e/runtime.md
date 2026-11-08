# Slack runtime recipes

## Custom feature flow

Start with the complete `slack-e2e-lifecycle.yaml`, keep `execution.channel: slack`
and isolation metadata, then change the actions/assertions needed for the
requested behavior. Load it directly; no catalog or TypeScript registration is
needed for a one-off scenario:

```bash
pnpm openclaw qa slack \
  --scenario-file /absolute/path/to/slack-proof.yaml \
  --output-dir .artifacts/qa-e2e/slack-custom
```

Multiple `--scenario-file` arguments use the shared QA scenario loader. Each flow
gets its own scenario cancellation signal and lease-bound readiness. Inspect
`channelE2e.doctor` for capability diagnostics. Assert its full `ok` verdict for
the lifecycle recipe, or select only relevant checks for a text-only proof:
missing optional file/reaction scopes do not block basic ingress. Use unique
synthetic markers; keep local media in the scenario workspace and remove only
those files in `try/finally` after upload.
Set `execution.retryCount: 0`; native-write recipes reject positive retry counts
because a failed response can follow an accepted write.

## Config and restart

Reuse the canonical `slack-restart-resume` shared flow for restart/resume proof.
For a custom policy change, copy the source-audited config flow pattern:
`readConfigSnapshot(env)`, construct the intended config from that snapshot, then
`applyConfig({env,nextConfig,...})`. Wait with `waitForGatewayHealthy` and
`waitForTransportReady` before sending another message. The existing flow helpers
own config hashes, config-apply restart settling, and Gateway handles. Use
`env.gateway.call('channels.status', {probe:false, timeoutMs:10000})` for runtime
status, not inferred process state.

Existing Slack modules use `slackScenarioContext.configureScenario(implementation)`
to build channel policy and patch the owned Gateway through the common config
owner. Follow their public environment contract when an advanced module is
needed. Do not edit generated config behind the owner, spawn another Gateway,
reuse a personal Gateway, claim a port by killing its holder, or start a separate
lease heartbeat. A custom config that disables the SUT connection must make its
own expected-unready assertion rather than calling a connected-readiness helper.

Use `--provider-mode mock-openai` for deterministic routing/restart work. A real
model/tool-choice question needs the authorized `live-frontier` lane and actual
model/tool transcript evidence. A successful fixture send or direct Gateway RPC
cannot substitute for that proof.

## Artifacts and cancellation

The shared suite owns lease acquisition/heartbeat, Gateway startup/stop, and lease
release. The opt-in adapter contributes fixture cleanup **after Gateway stop and
before release**, using still-held lease authority. It exposes heartbeat failure
to the suite's cancellation owner; native actions check the actual scenario
signal, stopped state, and lease authority before dispatch and after awaits.
A cancellation can arrive after Slack commits a write. A late exact receipt is
recorded before cancellation propagates so the owned fixture can still be cleaned.
Cancellation is not permission to issue more normal actions.

Inspect the standard `qa-suite-summary.json`, `qa-suite-report.md`, and
`qa-evidence.json`. Each custom scenario also writes
`<scenario-id>-slack-e2e.json`, a mode-0600 private native receipt/cleanup artifact.
The adapter snapshots all Gateway mutation receipts after confirmed process
shutdown, including uncertain outcomes. Unresolved Gateway effects preserve the
temporary capture database and fail cleanup; they never grant deletion ownership.
Safe receipt facts remain in the private E2E artifact; sanitized `gateway-debug`
logs are not that database. Keep identities, synthetic message bodies, capture,
and media private. Publish sanitized results, not raw capture or SDK errors.

## Cleanup and recovery

Automatic cleanup is opt-in for agent E2E; ordinary curated suite retention stays
unchanged. The new driver owns only exact fixture receipts, driver reaction adds,
returned driver upload IDs, correlated SUT replies, and Gateway-captured new
messages/uploads in its owned threads. Seeing a message or file in history does
not confer ownership. In particular a SUT reply can reference an existing file;
that file is retained unless this Gateway's upload-completion receipt proves it
was created in the owned thread. Raw-client/legacy module fixtures keep their
existing cleanup contract.

Cleanup removes only known-owned reactions, files, and messages with the correct
author's client. It never sweeps a channel. A lost lease blocks even cleanup
writes. Missing permissions or an ambiguous send leave private recovery evidence
and fail cleanup rather than claiming success. Pending native writes are allowed
to settle so their receipts can be retained; forcibly killing the runner can
prevent cleanup and requires owner recovery.

For an incomplete run, preserve its output directory and report the unresolved
operation/receipt IDs privately to the QA pool owner. Do not retry an uncertain
write, infer ownership from a time window, bulk-delete channel history, or reacquire
a random lease to clean another run. A hard-killed process or unknown receipt has
no automatic safe-recovery guarantee. Resolve ownership and current lease
authority before any manual deletion. Missing credentials/scopes are owner
prerequisites; ordinary Convex login is the bootstrap, not authorization to
reconfigure the broker or app.
