---
summary: "Optional plugin environment preparation for host and container execution"
title: "Execution environment registration"
read_when:
  - Reviewing plugin-owned process identity preparation
  - Registering an execution environment adapter
---

# Execution environment registration

`api.registerExecutionEnvironment(provider)` adds an optional execution
preparer to the admitted plugin registry. Import its versioned types from
`openclaw/plugin-sdk/execution-environment`.

The host captures registered contributions when preparing an agent's exec tool
or admitted native-harness environment. Existing plugins need not register one.
Native GitHub execution and account selection remain owned by their existing
implementation; contributions are composed with those facts, not substituted
for them. Conflicting identity values fail with the owners and environment key,
without exposing either value.

`prepare({ config, sourceConfig, agentId, assertCurrent, signal })` returns
nonsecret environment facts, excluded store names, optional Git parameters and an
optional `wrapLocalLaunch(argv)` callback. `prepareSandbox` returns container
scrub/identity maps, read-only mount descriptions, inherited environment names and
an optional launch wrapper. Returned facts must not contain bearer credentials.
Store exclusions belong to `prepare`, which is used for every exec placement,
and to the manifest-prepared snapshot described below; they are not a separate
sandbox-specific capability. Git parameters and the host-execution requirement
are also local-only facts, absent from the sandbox return type.

Local exec applies the nonsecret maps at the existing environment owner and
encloses the selected shell launch only after normal command policy and approval.
The wrapper receives the exact launch argv, including any native identity
adapter; it must preserve the reviewed command. A launch wrapper automatically
sets the host-execution requirement so native harnesses use existing host tools
instead of bypassing the adapter. `hostExecutionRequired: true` can also request
that route explicitly. No plugin-specific model-facing tool is added.

Sandbox preparation is separate: local identity maps are never implicitly copied
to a container. `prepareSandbox` receives the selected backend and isolation
scope and may decline by returning `undefined`. Docker and Podman consume its
environment maps, read-only mounts, inherited environment names and launch
adapter through their existing provisioning and process owners. Other backends
reject a sandbox contribution rather than silently ignoring it. Providers must
decline scopes that cannot safely share their selected identity. Inherited names
let a private launch adapter supply credentials at child launch; the host stages
only the nonsecret maps in its temporary engine env file.

Registration requires a managed plugin instance and a valid plugin-local id.
Duplicate ids within an owner are rejected. The existing plugin-instance owner
binds the preparers and their returned launch callbacks; retained callbacks stop
being callable when that instance is retired. These contracts do not grant
process execution, bypass command approval, or create sandbox permission.
The host also rechecks the captured instance and admitted execution authority at
the final process launch, including launches resumed after approval waits.

Manifest SecretRef paths may separately declare
`executionEnvironment: "exclude"`. Secret preparation records the referenced
environment/store names even while their plugin is disabled, without resolving
those credentials. Exec and harness preparation consume the active snapshot's
scrub maps, and exec excludes the recorded store names from its child environment
projection. With no contribution or exclusion, existing identity, shell, approval
and sandbox behavior remains unchanged.

## Git co-author formatting

An execution provider may also implement the synchronous, pure
`formatGitCoauthor(input)` callback. The host supplies only verified identities
whose profiles consent to public Git credit. `input.identity` contains the issuer,
opaque subject, name, and an optional verified email; `input.issuer` and
`excludeSubject` preserve an explicitly selected publication realm and author.
Return `{ name, trailer }`, `null` to deliberately omit that identity, or
`undefined` when this provider does not handle its issuer. Multiple providers
claiming the same identity fail visibly instead of choosing an arbitrary author.

The callback must not prepare credentials, execution environments, or network
requests. The host owns contributor merging, ordering, bounds, consent, and
currentness. It invokes the callback through the existing managed registration;
retained attribution becomes stale when its plugin retires. CLI and Codex prompt
preparation use their already selected runtime registry, without requiring a
running Gateway service. Existing prompt placement and bytes are retained.
