---
summary: "How the Gateway resolves, injects, and isolates secrets at runtime"
read_when:
  - Understanding owner isolation, sentinel injection, and the agent-access boundary
  - Diagnosing inactive-surface filtering or onboarding reference preflight failures
title: "Secrets runtime model"
---

This page covers how secrets behave at runtime: owner isolation, egress-time sentinel injection, the agent-access boundary, active-surface filtering, and the preflight diagnostics that report on them.

## Runtime model

- Secrets resolve into an in-memory runtime snapshot, eagerly during activation, not lazily on request paths.
- Cold Gateway startup isolates a retryable SecretRef failure to a known non-Gateway owner when that owner supports isolation. Mapped owner classes include model providers and skills, media/TTS/cron providers, eligible auth profiles, per-agent memory, sandbox SSH, channel accounts, and manifest-declared plugin routes. The Gateway starts, records the owner as configured-unavailable, and emits a redacted degradation warning. Gateway ingress auth, structurally invalid refs or resolved values, fail-closed owners, and refs whose runtime owner is not mapped still fail startup.
- Reload validates each mapped owner independently, then publishes one atomic snapshot. Healthy owners refresh. An eligible failed owner keeps its last-known-good value and becomes stale only when its ref identities, provider definitions, and complete non-secret owner contract are unchanged; a changed or new failed owner becomes cold. A strict failure rejects the reload and preserves the active snapshot.
- Config reload also reconciles channel connections when a secret-provider edit changes resolved credentials. Plugins that support account-scoped reload restart only the affected named accounts; shared, default, removed, or unresolved account changes use the plugin's whole-channel restart policy. Cold accounts stop, eligible stale accounts keep using their last-known-good credentials, and recovery preserves manual stops.
- Policy violations (for example an OAuth-mode auth profile combined with SecretRef input) fail activation before the runtime swap.
- Runtime requests read only the active in-memory snapshot. Model-provider SecretRef credentials pass through auth storage and stream options as process-local sentinels until egress. Outbound delivery paths (Discord reply/thread delivery, Telegram action sends) also read that snapshot and do not re-resolve refs per send.
- Read-only channel capability discovery evaluates accounts independently. A configured-but-unavailable account does not hide healthy sibling accounts' message actions, while direct sends through the unavailable account still fail closed.

This keeps secret-provider outages off hot request paths.

Gateway ingress protection, structurally invalid config or resolved values, policy violations, and unknown ownership still fail closed. Isolated owners never fall through to a lower-precedence credential source.

## Egress-time injection (sentinels)

For model-provider credentials backed by SecretRefs, OpenClaw mints an opaque, process-local sentinel during model-auth resolution. Auth storage, stream options, SDK configuration, logs, error objects, and most runtime introspection therefore see a value such as `oc-sent-v2.<authenticated-ciphertext>.end`, not the provider credential. The guarded model fetch and managed local-provider health probes replace known sentinels in URL and header values immediately before each request leaves the process.

Unknown sentinel-shaped values fail closed before network activity. OpenClaw refuses to send the request rather than forwarding an unresolved sentinel to a provider. Resolved secret values are also registered for exact-value log redaction as a defense in depth measure.

Provider adapters use the latest injection point their SDK supports:

- SDKs with a custom fetch option receive OpenClaw's guarded fetch, so the SDK retains the sentinel.
- SDKs without a custom fetch option unwrap the sentinel immediately before client construction. Plugin-owned provider streams and agent harnesses unwrap at the final core-owned handoff because those transports do not share OpenClaw's guarded fetch.

Sentinels reduce plaintext exposure across the model-call chain, but they are not process isolation. The real value still exists in same-process memory and appears at the final adapter boundary. Plain environment credentials that are not configured through SecretRefs remain plaintext and are outside this mechanism.

Set `OPENCLAW_SECRET_SENTINELS=off` (also accepts `0` or `false`, case-insensitive) to disable model-provider sentinel minting during incident response or compatibility troubleshooting. This switch disables neither exact-value redaction registration nor protected-store sealing for Gateway-hosted subprocesses.

## Agent-access boundary

SecretRefs stop credentials from being persisted in config and generated model files, but they are not a process-isolation boundary. A plaintext credential left on disk in a path the agent can read is still readable via file or shell tools, bypassing API-level redaction.

For production deployments where agent-accessible files are in scope, treat migration as complete only when all of these hold:

- Supported credentials use SecretRefs instead of plaintext values.
- Legacy plaintext residue is scrubbed from `openclaw.json`, the SQLite auth-profile store, `.env`, and generated `models.json` files. Retired auth JSON is doctor-owned migration input and is never rewritten by `secrets apply`.
- `openclaw secrets audit --check` is clean after migration.
- Any remaining unsupported or rotating credentials are protected by OS isolation, container isolation, or an external credential proxy.

This is why the audit/configure/apply workflow is a security migration gate, not just a convenience helper.

<Warning>
SecretRefs do not make arbitrary readable files safe. Backups, copied configs, old generated model catalogs, and unsupported credential classes stay production secrets until deleted, moved outside the agent trust boundary, or isolated separately.
</Warning>

## Active-surface filtering

SecretRefs are validated only on effectively active surfaces:

- **Enabled surfaces**: retryable failures for mapped, isolatable owners enter cold or stale degradation. Strict, fail-closed, Gateway-required, or unmapped failures block startup/reload.
- **Inactive surfaces**: unresolved refs do not block startup/reload; they emit a non-fatal `SECRETS_REF_IGNORED_INACTIVE_SURFACE` diagnostic.

<Accordion title="Examples of inactive surfaces">
- Disabled channel/account entries.
- Top-level channel credentials that no enabled account inherits.
- Disabled tool/feature surfaces.
- Web search provider-specific keys not selected by `tools.web.search.provider`. In auto mode (provider unset), keys are consulted by precedence for auto-detection until one resolves; after selection, non-selected provider keys are inactive.
- Sandbox SSH auth material (`agents.defaults.sandbox.ssh.identityData`, `certificateData`, `knownHostsData`, plus per-agent overrides) is active only when the effective sandbox backend is `ssh` and sandbox mode is not `off`, for the default agent or an enabled agent.
- `gateway.remote.token` / `gateway.remote.password` SecretRefs are active if any of these hold:
  - `gateway.mode=remote`
  - `gateway.remote.url` is configured
  - `gateway.tailscale.mode` is `serve` or `funnel`
  - In local mode without those remote surfaces: `gateway.remote.token` is active when token auth can win and no env/auth token is configured; `gateway.remote.password` is active only when password auth can win and no env/auth password is configured.
- Active `gateway.auth.token` / `gateway.auth.password` SecretRefs stay authoritative over `OPENCLAW_GATEWAY_TOKEN` / `OPENCLAW_GATEWAY_PASSWORD`; environment credentials are fallbacks when the corresponding local config input is absent.

</Accordion>

## Gateway auth surface diagnostics

When a SecretRef is set on `gateway.auth.token`, `gateway.auth.password`, `gateway.remote.token`, or `gateway.remote.password`, gateway startup/reload logs the surface state under code `SECRETS_GATEWAY_AUTH_SURFACE`:

- `active`: the SecretRef is part of the effective auth surface and must resolve.
- `inactive`: another auth surface wins, or remote auth is disabled/not active.

The log entry includes the reason the active-surface policy used.

## Onboarding reference preflight

In interactive onboarding, choosing SecretRef storage runs preflight validation before saving:

- Env refs: validates the env var name and confirms a non-empty value is visible during setup.
- Provider refs (`file`, `exec`, or `store`): validates provider selection, resolves `id`, and checks the resolved value type.
- Quickstart flow: when `gateway.auth.token` is already a SecretRef, onboarding resolves it before probe/dashboard bootstrap (for `env`, `file`, `exec`, and `store` refs) using the same fail-fast gate.
- Generated gateway token: setup mints `gateway.auth.token` itself, so reference mode has nothing to prompt for. With `OPENCLAW_GATEWAY_TOKEN` exported it writes an `env` ref to that variable, keeping a later rotation authoritative; otherwise it writes the token to the secret store under `OPENCLAW_GATEWAY_TOKEN` and stores a `store` ref. An existing store entry is reused rather than rotated, so re-running setup never invalidates already-paired clients.

Validation failure shows the error and lets you retry.
