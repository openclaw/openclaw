---
doc-schema-version: 1
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

Windows worker-local inference is deferred. Windows nodes do not advertise this
capability; use Gateway inference there. Existing Gateway-proxied workers retain
their current behavior. Windows support needs a separate, opt-in
credential-transport implementation and native validation.

Install matching Gateway and node builds and pair the node normally. Put the
external custodian's opaque auth values in the node service's provisioned startup
environment, not Gateway configuration or profile settings. Configure the
endpoint and model catalog through the familiar top-level `models.providers`
field in the **node's** `openclaw.json`, then enable worker hosting:

```json5
{
  models: {
    providers: {
      openai: {
        api: "openai-completions",
        baseUrl: "https://credential-proxy.example.test/v1",
        apiKey: "${WORKER_PROXY_AUTH}",
        models: [
          {
            id: "worker-model",
            name: "Worker model",
            contextWindow: 32768,
            maxTokens: 4096,
            reasoning: true,
            thinkingLevelMap: { low: "low", high: "high" },
            input: ["text", "image"],
            cost: { input: 2, output: 8, cacheRead: 1, cacheWrite: 2 },
          },
        ],
      },
    },
  },
  nodeHost: {
    workerRuns: {
      enabled: true,
      capacity: 1,
      isolation: "none",
    },
  },
}
```

The external platform may run the node inside a container. OpenClaw's additional
nested-container worker mode is not supported for local inference. Keep the node
configuration and service environment readable only by the service account. For a trusted private proxy CA,
provision a read-only CA bundle through the node service's `NODE_EXTRA_CA_CERTS`,
or use its `NODE_USE_SYSTEM_CA` setting. The existing worker environment preserves
these settings; it does not inherit `NODE_OPTIONS` or generic `HTTP_PROXY` /
`HTTPS_PROXY` variables. Configure the compatible proxy endpoint explicitly as
`baseUrl`, and never disable certificate verification.

Replace the endpoint with your external custodian's compatible API and use its
model metadata. Prices are per million tokens. `apiKey` uses the same literal,
environment interpolation, and supported SecretRef forms as ordinary OpenClaw
model configuration; provision an externally scoped proxy value rather than a
raw provider key. Optional provider and model `headers` are node-local startup
values too. All configured header values are conservatively protected from worker
diagnostics and protocol output.

Every compatible model under `models.providers` with a usable credential is
available to worker-local turns on this node. There is no second workspace/model
allowlist. The supervisor projects the exact admitted workspace into each child,
and both node and worker check its normalized identity. Model configuration is not
loaded from the workspace, a turn request, Gateway auth profiles, or dotenv files.

The node snapshots its saved model configuration and resolved auth values at
startup. Rotation requires controlled node/worker replacement through your
platform lifecycle; it does not mutate a running snapshot. The private startup carrier is removed before
tools execute to avoid accidental inheritance, not to isolate it from same-user code. Workspace preparation, repository setup, and unrelated proxied
workers do not inherit it.

## Select the placement on the Gateway

Configure an explicit device profile with the paired device ID:

```json5
{
  models: {
    providers: {
      openai: {
        api: "openai-completions",
        models: [
          {
            id: "worker-model",
            name: "Worker model",
            contextWindow: 32768,
            maxTokens: 4096,
            reasoning: true,
            thinkingLevelMap: { low: "low", high: "high" },
            input: ["text", "image"],
            cost: { input: 2, output: 8, cacheRead: 1, cacheWrite: 2 },
          },
        ],
      },
    },
  },
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

The Gateway copy supplies runtime metadata for this custom model reference so it
can authorize the selection and prepare tools. Keep those capabilities aligned
with the node definition, but leave `baseUrl`, `apiKey`, and secret `headers`
only in the node configuration. A model already present in the Gateway's catalog
does not need this additional metadata entry.

### Make the dedicated worker mandatory

To require this worker for OpenClaw turns, add
`requiredProfile: "dedicated-native"` alongside `cloudWorkers.profiles` in the
example above. See [Required worker profile](/gateway/config-cloud-workers#required-worker-profile)
for admission, permissions, empty workspaces, and existing-session behavior.
The configured agent model remains the default.

Provision the paired node and native registry before admitting chats. Enrollment
can begin before the required profile is usable, but chats remain blocked while
it is missing, unavailable, or preparing. Do not copy provider credentials to the
Gateway to work around a placement error. Retry and Stop use the retained session
and placement; initial-message recovery never falls back to Gateway execution.

Leave `requiredProfile` unset for the optional, administrator-selected flow below.

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
checks. An explicit `agentRuntime` requires an explicit normalized `model` and an
available Gateway runtime choice. The model picker is not a catalog of the node's
model configuration. Use the configured-default flow above; do not copy worker
auth values to the Gateway or disable auth checks to make an explicit selection pass.
These are selection-time checks: they do not make Gateway provider auth a
requirement for continuing an already-bound worker-inference session, including
an earlier accepted model selection. Gateway authentication, agent/model
authorization, tool permissions, session and placement access, and current-run
authority still apply.

The launch carries a feature-gated inference choice and the existing model
reference, not model endpoints, headers, or provider credentials. Missing local
configuration, unavailable models, incompatible workers, and provider errors block
the turn. The worker and Gateway both reject proxy fallback for local turns.
Omitting `settings.inference`, or setting it to `gateway`, preserves the default.

## Troubleshooting

Worker-local inference stops on error. A failed turn never falls
back to Gateway inference, because that would silently change credential custody
and placement. Use the first matching diagnostic below, fix its owner, then retry
or restart the failed worker placement.

| Diagnostic                                         | What to fix                                                                                                                                                                                |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `settings.inference must be "gateway" or "worker"` | Set the selected device profile's `settings.inference` to one of those exact values. Omit it to keep Gateway inference.                                                                    |
| `requires a paired device profile`                 | Set `cloudWorkers.profiles.<id>.settings.device` to the connected node ID and dispatch through that profile, not the ordinary device target.                                               |
| `cannot use ... for agent ...`                     | Allow the model in that agent's model policy, or choose an allowed configured default.                                                                                                     |
| `missing from the Gateway model catalog`           | Add non-secret metadata for the same model reference under the Gateway's `models.providers`. Keep `baseUrl`, credentials, and secret headers on the node.                                  |
| `unavailable on paired device ...`                 | Update and restart the node host. Use Linux or macOS, set `nodeHost.workerRuns.isolation` to `"none"`, and check that the node has at least one compatible model with a usable credential. |
| `not configured on this node`                      | Add a compatible model and usable credential under the node's `models.providers`, then restart the node host so it snapshots the new configuration.                                        |
| `model ... is unavailable on this node`            | Configure that exact provider/model reference and credential in the node's `openclaw.json`, then restart the node host.                                                                    |
| `startup data exceeds 2 MiB`                       | Reduce the number or size of configured node models and headers, then restart the node host.                                                                                               |

If the Control UI reports **Runner failed**, open the placement details for the
diagnostic. Restarting without changing the named configuration will repeat the
same failure. Gateway logs do not contain node credentials or the node-local
model catalog in full.

## Upgrade and downgrade

The supported profile values are `gateway` and `worker`; omission means `gateway`.
Upgrading a released installation does not enable worker inference or add native
configuration. Already allocated environments retain their original snapshots;
profile edits do not change an active binding. No database rewrite or
schema-version change is needed.

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

1. Stop new submissions and resolve pending required-placement first messages in
   every browser tab before replacing the Control UI. Confirm each message's
   outcome in its session history; finish or explicitly retire its pending
   recovery on the current build. If the outcome is unresolved, keep the current
   build and save the message text and attachments separately. Do not blindly
   resend an unconfirmed message. Older Control UI builds reject the required
   placement recovery marker and cannot restore that pending input; removing the
   configuration setting does not migrate browser recovery records.

   Finish or stop active turns, and reclaim every native placement while the
   compatible Gateway and node are still running. Use
   **Stop cloud worker…** or the existing RPC:

   ```bash
   openclaw gateway call sessions.reclaim --json --timeout 600000 \
     --params '{"key":"SESSION_KEY","agentId":"assistant"}'
   ```

   Wait for successful reconciliation and a `reclaimed` or `local` placement.
   An offline device or pending teardown is not confirmed release; reconnect and
   resolve cleanup before continuing. Do not force-destroy merely to downgrade.

2. Remove `cloudWorkers.requiredProfile` if set, then remove the native profiles from `cloudWorkers.profiles` and any defaults that
   reference them. Removing a profile does not change an active environment's
   recorded inference choice; reclaim it first. Retire worker-only model entries
   and auth environment through your platform lifecycle if they are no longer
   used by ordinary node-local OpenClaw operation.
3. Downgrade only after that cleanup. Older Gateways do not interpret
   `settings.inference` as a local-inference requirement. Do not leave native
   placements or profiles for an older Gateway to recover. Any later Gateway or
   proxied turn needs its own configured provider credentials.

## Behavior and limits

- Coding tools execute in the worker. Existing grants and permission modes apply.
  Interactive exec approvals and worker LLM-review approval transport remain
  unsupported; approval-required execution is denied, not auto-approved.
- The node's saved model configuration owns the real model API, input capabilities, context window,
  output-token limit, prices, and thinking support. Unsupported thinking and
  conflicting token-budget overrides are rejected. The existing worker replay
  projection preserves supported provider replay in stored Gateway transcripts.
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
TEST_NATIVE_WORKER_BUNDLE=1 node scripts/run-vitest.mjs run src/worker/native-worker.bundle.integration.test.ts
```

The opt-in lane uses the supported prepackaged, SHA-addressed archive path and
checks the real installer, prewarm, supervisor, and worker; it does not exercise
archive acquisition over HTTP. It fails if matching build artifacts are missing. Follow normal [node and worker setup](/gateway/cloud-workers/setup-and-bundle-installation)
for installation; this feature does not deploy or restart services automatically.
