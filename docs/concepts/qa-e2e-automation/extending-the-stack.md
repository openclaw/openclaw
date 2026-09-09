---
doc-schema-version: 1
summary: "Repo-backed seed assets, provider mock lanes, transport adapters, and what adding a channel takes."
read_when:
  - You are adding QA scenarios or seed assets
  - You are adding or extending a transport adapter
title: "Extending the QA stack"
---

## Repo-backed seeds

Seed assets live in `qa/`:

- `qa/scenarios/index.yaml`
- `qa/scenarios/<theme>/*.yaml`

Identity-sensitive channel changes use the isolated
`channel-participant-identity-inspection` QA Channel flow. It drives a real
ephemeral Gateway and mock provider, then inspects admitted runs with the same
`openclaw audit --run ... --explain` JSON and human surfaces operators use.
The flow includes lifecycle-owned restart and a row-count check for rejected
pre-run ingress.

These are intentionally in git so the QA plan is visible to both humans and
the agent.

`qa-lab` stays a generic YAML scenario runner. Each scenario YAML file is the
source of truth for one test run and should define:

- top-level `title`
- `scenario` metadata
- optional category, capability, lane, and risk metadata in `scenario`
- docs and code refs in `scenario`
- optional plugin requirements in `scenario`
- optional gateway config patch in `scenario`
- executable top-level `flow` for flow scenarios, or
  `scenario.execution.kind` / `scenario.execution.path` for Vitest and
  Playwright scenarios

The reusable runtime surface that backs `flow` stays generic and
cross-cutting. For example, YAML scenarios can combine transport-side
helpers with browser-side helpers that drive the embedded Control UI through
the Gateway `browser.request` seam without adding a special-case runner.

Scenario files should be grouped by product capability rather than source
tree folder. Keep scenario IDs stable when files move; use `docsRefs` and
`codeRefs` for implementation traceability.

The baseline list should stay broad enough to cover:

- DM and channel chat
- thread behavior
- message action lifecycle
- cron callbacks
- memory recall
- model switching
- subagent handoff
- repo-reading and docs-reading
- one small build task such as Lobster Invaders

## Provider mock lanes

`qa suite` has two local provider mock lanes:

- `mock-openai` is the scenario-aware OpenClaw mock. It remains the default
  deterministic mock lane for repo-backed QA and parity gates.
- `aimock` starts an AIMock-backed provider server for experimental
  protocol, fixture, record/replay, and chaos coverage. It is additive and
  does not replace the `mock-openai` scenario dispatcher.

For an IPv6 loopback server, run `pnpm openclaw qa mock-openai --host ::1`.
The printed URL includes brackets, such as `http://[::1]:<port>`; use that URL
when configuring a client. QA Lab also brackets IPv6 hosts in its listen and
advertised URLs. Pass the bare address to `--host`.

Provider-lane implementation lives under `extensions/qa-lab/src/providers/`.
Each provider owns its defaults, local server startup, gateway model config,
auth-profile staging needs, and live/mock capability flags. Shared suite and
gateway code routes through the provider registry instead of branching on
provider names.

## Transport adapters

`qa-lab` owns a generic transport seam for YAML QA scenarios. `qa-channel` is
the synthetic default. `crabline` starts separate local provider servers and
runs OpenClaw's normal channel plugins against their provider-shaped REST and
streaming boundaries; it does not use Crabline's fixture-level local mock
providers. `live` is reserved for real provider credentials and external
channels.

At the architecture level, the split is:

- `qa-lab` owns generic scenario execution, worker concurrency, artifact
  writing, and reporting.
- The transport adapter owns gateway config, readiness, inbound and outbound
  observation, transport actions, and normalized transport state.
- YAML scenario files under `qa/scenarios/` define the test run; `qa-lab`
  provides the reusable runtime surface that executes them.

### Adding a channel

Adding a channel to the YAML QA system requires the channel implementation
plus a scenario pack that exercises the channel contract. For smoke CI
coverage, add the matching Crabline local provider server and expose it
through the `crabline` driver.

Do not add a new top-level QA command root when the shared `qa-lab` host can
own the flow.

`qa-lab` owns the shared host mechanics:

- the `openclaw qa` command root
- suite startup and teardown
- worker concurrency
- artifact writing
- report generation
- scenario execution
- compatibility aliases for older `qa-channel` scenarios

Runner plugins own the transport contract:

- how `openclaw qa <runner>` is mounted beneath the shared `qa` root
- how the gateway is configured for that transport
- how readiness is checked
- how inbound events are injected
- how outbound messages are observed
- how transcripts and normalized transport state are exposed
- how transport-backed actions are executed
- how transport-specific reset or cleanup is handled

The minimum adoption bar for a new channel:

1. Keep `qa-lab` as the owner of the shared `qa` root.
2. Implement the transport runner on the shared `qa-lab` host seam.
3. Keep transport-specific mechanics inside the runner plugin or channel
   harness.
4. Mount the runner as `openclaw qa <runner>` instead of registering a
   competing root command. Runner plugins should declare `qaRunners` in
   `openclaw.plugin.json` and export a matching `qaRunnerCliRegistrations`
   array from a lightweight `qa-runner-api.ts` surface. Installed plugins using
   the shipped `runtime-api.ts` contract remain supported through 2026-10-01
   while authors migrate. Keep runner execution behind lazy entrypoints. An
   optional `adapterFactory` exposes the transport to shared scenarios without
   changing the command's existing scenario catalog. Same-channel partitions
   are serial unless the factory declares that every instance owns isolated
   credentials or disposable servers, Gateway state, and artifact paths.
   Module-backed flow scenarios additionally require
   `adapterFactory.supportsModuleFlows: true`; those factories must return
   adapters that implement `prepareFlow`.
5. Author or adapt YAML scenarios under the themed `qa/scenarios/`
   directories.
6. Use the generic scenario helpers for new scenarios.
7. Keep existing compatibility aliases working unless the repo is doing an
   intentional migration.

The decision rule is strict:

- If behavior can be expressed once in `qa-lab`, put it in `qa-lab`.
- If behavior depends on one channel transport, keep it in that runner
  plugin or plugin harness.
- If a scenario needs a new capability that more than one channel can use,
  add a generic helper instead of a channel-specific branch in `suite.ts`.
- If a behavior is only meaningful for one transport, keep the scenario
  transport-specific and make that explicit in the scenario contract.

### Scenario helper names

Preferred generic helpers for new scenarios:

- `waitForTransportReady`
- `waitForChannelReady`
- `injectInboundMessage`
- `injectOutboundMessage`
- `waitForOutboundMessage`
- `waitForNoTransportOutbound`
- `getTransportSnapshot`
- `readTransportMessage`
- `readTransportTranscript`
- `formatTransportTranscript`
- `resetTransport`

Compatibility aliases remain available for existing scenarios -
`waitForQaChannelReady`, `waitForNoOutbound`, `formatConversationTranscript`,
and `resetBus` - but new scenario authoring should use the generic names.
Use the canonical `waitForOutboundMessage` for outbound checks instead of
adding transport- or channel-specific outbound wait aliases.
