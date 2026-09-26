---
summary: "Worker inference on an externally managed paired worker host"
title: "Worker-local inference"
read_when:
  - Hosting a dedicated native worker on an externally managed machine
  - Routing worker provider requests through an external credential custodian
---

# Worker-local inference

Worker turns normally proxy model requests through the Gateway. A configured
paired-device profile can instead select **worker inference**, using the
same admission, turn claims, local coding tools, transcript commits, live events,
and node supervisor. There is no separate runtime server or network protocol.

Your platform owns the host, container, or Pod and its revision. The built-in
`device` provider adopts a paired node and releases logical leases; it does not
create, replace, or delete the platform workload. The supervisor still owns its
worker children and managed workspaces. Use a dedicated node account per trust
boundary. Workspace grants are not an operating-system sandbox: code running as
that account has its normal filesystem and process access.

## Deployment and credential trust contract

Keep the trusted OpenClaw Gateway outside the untrusted worker workload. The
paired node and its worker run the native loop and coding tools; they are not a
credential-isolation boundary from code running as the same operating-system
user. Such code may access startup files, environment, and process memory. A
private startup pipe and output redaction do not change that trust boundary.

For this deployment, an external credential custodian or provider proxy must hold
the actual provider keys outside the workload. Configure the node's model endpoint
to reach that service and provision only the service's scoped, opaque auth values
into the node. OpenClaw passes those values through the chosen provider adapter;
it does not interpret them as provider keys, resolve them into keys, or implement
the custodian. Native provider operations use their own transport policy rather
than the Gateway's process-local secret-marker interpretation or guarded-fetch/SSRF
policy, including when the embedded loop imports Gateway helpers. Gateway
requests retain their existing policy. The provisioned endpoint and workload
egress restrictions are therefore deployment trust decisions. Native provider requests require HTTPS, remain on the configured endpoint origin,
and reject all redirects, including same-origin redirects. Provision the final
endpoint URL. Plain HTTP is allowed only for literal loopback IP addresses (not
DNS names such as localhost), for a trusted same-host hop or isolated wire proof.
That exception is not an external credential-isolation boundary. Normal TLS
certificate and hostname verification stays enabled. Adapter-specific
authentication framing and HTTP header rules still apply. Do not provision actual provider keys on the node or worker.

Startup checks transport policy and the presence of the named auth value; it
cannot tell a raw provider key from an opaque token, attest a custodian, or enforce
the workload's operating-system egress restrictions. Any nonempty named value
would otherwise satisfy credential presence. The broker-only custody rule is a
deployment requirement, not a claim that OpenClaw technically verifies key origin.

The deployment owns isolation of the Gateway and custodian, workload egress,
endpoint trust, token issuance, scope, expiry, revocation, and provider credential
rotation. Anyone able to read a workload token may exercise its externally
granted authority. OpenClaw workspace/model grants, turn cancellation, and output
redaction complement that deployment policy; they do not revoke an exposed token
or replace external authorization. Provisioning and live qualification of that
external service are outside this core feature.

## Provision the node

Windows worker-local inference is deferred. A Windows node rejects
`nodeHost.workerRuns.nativeInferenceConfig` before reading the registry or
credentials. Leave that setting unset and use Gateway inference on Windows;
existing Gateway-proxied workers retain their current behavior. Windows support
needs a separate, opt-in credential-transport implementation and native validation.

Install matching Gateway and node builds and pair the node normally. Put the
external custodian's opaque auth values in the node service's provisioned startup
environment, not Gateway configuration or profile settings. In the **node's**
configuration:

```json5
{
  nodeHost: {
    workerRuns: {
      enabled: true,
      capacity: 1,
      isolation: "none",
      nativeInferenceConfig: "/etc/openclaw/worker-inference.json",
    },
  },
}
```

The external platform may run the node inside a container. OpenClaw's additional
nested-container worker mode is not supported for local inference. Make the
registry file readable only by the service account. For a trusted private proxy CA,
provision a read-only CA bundle through the node service's `NODE_EXTRA_CA_CERTS`,
or use its `NODE_USE_SYSTEM_CA` setting. The existing worker environment preserves
these settings; it does not inherit `NODE_OPTIONS` or generic `HTTP_PROXY` /
`HTTPS_PROXY` variables. Configure the compatible proxy endpoint explicitly as
`baseUrl`, and never disable certificate verification.

For example, with node state
rooted at `/srv/worker-state`:

```json validate=false
{
  "models": [
    {
      "provider": "openai",
      "id": "worker-model",
      "api": "openai-completions",
      "baseUrl": "https://credential-proxy.example.test/v1",
      "contextWindow": 32768,
      "maxTokens": 4096,
      "reasoning": true,
      "thinkingLevelMap": { "low": "low", "high": "high" },
      "cost": { "input": 2, "output": 8, "cacheRead": 1, "cacheWrite": 2 },
      "apiKeyEnv": "WORKER_PROXY_AUTH"
    }
  ],
  "workspaces": [
    {
      "id": "assistant",
      "path": "/srv/worker-state/node-host",
      "scope": "subdirectories",
      "models": ["openai/worker-model"]
    }
  ]
}
```

Replace the endpoint with your external custodian's compatible API and use its
model metadata. Prices are per million tokens. Despite its name, `apiKeyEnv` names
a variable containing an opaque proxy auth value, not an actual provider key.
The registry contains the variable name, never the value. Optional `headers` are
node-local startup values too; use only metadata or externally scoped auth there. Known credential-bearing
header names are protected automatically. List nonstandard authentication header
names in the model's `sensitiveHeaderNames` array (case-insensitive); other headers
remain ordinary metadata. For example, `"sensitiveHeaderNames": ["X-Session"]`
classifies a configured `X-Session` value without classifying a routing header.
No model configuration is
loaded from the workspace, a turn request, Gateway auth profiles, or dotenv files.

A workspace grant's `id` is the exact agent ID. Omitted `scope` means an exact
workspace path. Explicit `subdirectories` allows normal dispatch to create
generated workspaces below a stable operator-selected root; you do not predict
environment/session directory names. Both node and worker check canonical
containment, and the runtime pins directory identity during the turn. Use a
narrower existing root when possible. Optional `sessionId` restricts a grant to
one known session incarnation. List `models` explicitly: each child receives only
its agent's grant and permitted model auth values.

The supervisor snapshots the file and named auth values at startup. Rotation
requires controlled node/worker replacement through your platform lifecycle; it
does not mutate a running registry. The private startup carrier is removed before
tools execute to avoid accidental inheritance, not to isolate it from same-user code. Workspace preparation, repository setup, and unrelated proxied
workers do not inherit it.

## Select the placement on the Gateway

Configure an explicit device profile with the paired device ID:

```json5
{
  agents: {
    defaults: {
      model: { primary: "openai/worker-model" },
      models: { "openai/worker-model": { agentRuntime: { id: "openclaw" } } },
    },
    entries: { assistant: {} },
  },
  cloudWorkers: {
    profiles: {
      "dedicated-native": {
        provider: "device",
        settings: {
          device: "PAIRED_DEVICE_ID",
          inference: "worker",
        },
      },
    },
  },
}
```

### Create and dispatch with worker proxy authentication

Use an authenticated operator CLI/API connection and the configured default
model with the OpenClaw runtime. Profile dispatch requires `operator.admin`.
Create the session without an initial message or explicit `model`/`agentRuntime`
selection, dispatch it to the configured profile, then submit its first turn:

```bash
openclaw gateway call sessions.create --json \
  --params '{"agentId":"assistant","label":"native-work","worktree":true,"worktreeSource":"empty"}'

# Replace SESSION_KEY with the key returned by sessions.create.
openclaw gateway call sessions.dispatch --json --timeout 240000 \
  --params '{"key":"SESSION_KEY","agentId":"assistant","profileId":"dedicated-native"}'

# Wait for placement.state to be active before sending.
# Use a fresh idempotencyKey for each new turn.
openclaw gateway call agent --json --timeout 180000 \
  --params '{"agentId":"assistant","sessionKey":"SESSION_KEY","message":"Say hello from the worker.","deliver":false,"idempotencyKey":"native-work-turn-1","timeout":120}'

# Replace RUN_ID with the runId returned by agent; acceptance is not completion.
openclaw gateway call agent.wait --json --timeout 195000 \
  --params '{"runId":"RUN_ID","timeoutMs":180000}'
```

The empty workspace is session-owned. For a repository-backed session, use the
[repository create/dispatch flow](/gateway/cloud-workers/placement-and-machine-selection#codex-or-openclaw-on-a-cloud-profile)
instead, still omitting an initial message and explicit model/runtime selection.
Select `profileId`, not the ordinary paired-device target: ordinary device
placement remains proxied.

In the Control UI, choose the named worker-inference profile and keep the agent's
configured model and OpenClaw runtime defaults. The profile and active placement
identify worker inference without exposing provider settings or credentials.
Existing sessions use their bound environment's recorded choice, not later edits
to the profile. Stopped, reclaimed, and inexact placements do not establish a
current worker-inference binding.

**Current limitation:** explicit model/runtime selection still uses Gateway
model availability and auth checks; worker proxy auth values do not satisfy those
checks. An explicit `agentRuntime` requires an explicit canonical `model` and an
available Gateway runtime choice. The model picker is not a catalog of the node's
local registry. Use the configured-default flow above; do not copy worker
auth values to the Gateway or disable auth checks to make an explicit selection pass.
These are selection-time checks: they do not make Gateway provider auth a
requirement for continuing an already-bound worker-inference session, including
an earlier accepted model selection. Gateway authentication, agent/model
authorization, tool permissions, session and placement access, and current-run
authority still apply.

The launch carries a feature-gated inference choice and the existing model
reference, not model endpoints, headers, or provider credentials. Missing local
configuration, denied grants, incompatible workers, and provider errors fail
closed. The worker and Gateway both reject proxy fallback for local turns.
Omitting `settings.inference`, or setting it to `gateway`, preserves the default.

## Upgrade and downgrade

The canonical profile values are `gateway` and `worker`; omission means `gateway`.
For operators who tried pre-release builds, `openclaw doctor --fix` renames the
earlier device-profile spelling `runtime-local` to `worker`. This is compatibility
for explicit pre-release opt-in state, not a migration from a published release.
Upgrading a released installation does not enable worker inference or add native
configuration. Gateway startup uses that same shared migration when eligible;
[config migration safeguards](/gateway/doctor/config-migrations) still apply.
Already allocated environments retain their original snapshots. Both recorded
spellings mean worker inference until those environments retire; neither silently
selects Gateway inference. No database rewrite or schema-version change is needed.
The internal worker launch spelling and capability remain unchanged.

Upgrade the Gateway and node service to compatible builds that support
worker-local inference before enabling the profile. The Gateway installs its
pinned worker bundle on the paired node and validates its build receipt; a new
worker bundle alone does not upgrade the node supervisor or give an older node
the native startup configuration. Local turns require the
`worker-local-inference-v1` capability and never fall back to Gateway inference
on an incompatible worker. Follow the normal
[worker update and recovery lifecycle](/gateway/cloud-workers/session-lifecycle)
and your platform's node-service replacement procedure.

Before downgrading either service to a build without this feature:

1. Stop new submissions, finish or stop active turns, and reclaim every native
   placement while the compatible Gateway and node are still running. Use
   **Stop cloud worker…** or the existing RPC:

   ```bash
   openclaw gateway call sessions.reclaim --json --timeout 600000 \
     --params '{"key":"SESSION_KEY","agentId":"assistant"}'
   ```

   Wait for successful reconciliation and a `reclaimed` or `local` placement.
   An offline device or pending teardown is not confirmed release; reconnect and
   resolve cleanup before continuing. Do not force-destroy merely to downgrade.

2. Remove the native profiles from `cloudWorkers.profiles` and any defaults that
   reference them, then remove `nodeHost.workerRuns.nativeInferenceConfig` from
   the node configuration. Removing a profile does not change an active
   environment's recorded inference choice; reclaim it first. Retire the
   node-local registry and auth environment through your platform lifecycle.
3. Downgrade only after that cleanup. Older node schemas reject
   `nativeInferenceConfig`, and older Gateways do not interpret
   `settings.inference` as a local-inference requirement. Do not leave native
   placements or profiles for an older Gateway to recover. Any later Gateway or
   proxied turn needs its own configured provider credentials.

## Behavior and limits

- Coding tools execute in the worker. Existing grants and permission modes apply.
  Interactive exec approvals and worker LLM-review approval transport remain
  unsupported; approval-required execution is denied, not auto-approved.
- The local registry owns real model API, input capabilities, context window,
  output-token limit, prices, and thinking support. Unsupported thinking and
  conflicting token-budget overrides are rejected. The existing worker replay
  projection preserves supported provider replay in canonical Gateway transcripts.
- Automatic compaction and retry remain disabled by the existing worker runtime.
  Local inference does not add an alternative compaction path.
- Azure adapters requiring ambient endpoint configuration and ambient Vertex ADC
  marker credentials are rejected. Provider plugin loading is not added.
- Cancellation and replacement use existing worker fencing and terminate local
  model requests. After the first successful admission, losing the Gateway
  connection also stops the current local turn. Reconnection can settle that
  interrupted turn but does not resume its provider request; a fresh turn needs
  fresh admission. Initial connection/admission retries remain supported. The
  Gateway retains transcripts, acknowledgments, and terminal settlement.
- The runtime guards literal credential reflection, including stream fragments
  and normalized values. This is not general data-loss prevention or an isolation
  boundary against code running as the node's operating-system user.

## Verification

Focused compiled-process proof uses an isolated real Gateway service, SQLite
transcripts, a spawned worker, and a loopback HTTP model fixture:

```bash
node scripts/run-vitest.mjs run src/worker/native-worker.integration.test.ts
```

It covers local provider calls and tools, transcript persistence, denial,
cancellation, replacement, and the proxied sibling. This is not a paid-provider, external-custodian isolation,
or live platform deployment test. The test runner compiles the source fixture
through its owned runtime graph; it does not use an ad hoc TS loader in the child.
To verify the actual deploy bundle, installer, and node supervisor:

```bash
pnpm build
OPENCLAW_TEST_NATIVE_WORKER_BUNDLE=1 node scripts/run-vitest.mjs run src/worker/native-worker.bundle.integration.test.ts
```

The opt-in lane uses the supported prepackaged, SHA-addressed archive path and
checks the real installer, prewarm, supervisor, and worker; it does not exercise
archive acquisition over HTTP. It fails if matching build artifacts are missing. Follow normal [node and worker setup](/gateway/cloud-workers/setup-and-bundle-installation)
for installation; this feature does not deploy or restart services automatically.
