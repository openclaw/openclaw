---
summary: "Host-owned completions, model-selection policy, and provider auth resolution"
read_when:
  - You need a host-owned text completion without importing provider internals
  - You are resolving a model reference against an agent allowlist
  - You are resolving provider credentials or auth profiles
title: "Plugin runtime model helpers"
sidebarTitle: "Model helpers"
---

Call a model, resolve model-selection policy, and resolve provider auth without importing host internals. Part of the [Plugin runtime helpers](/plugins/sdk-runtime) reference.

## Protected model egress for standalone commands

`withConfiguredModelEgress` from `openclaw/plugin-sdk/secret-egress-runtime`
runs an explicit standalone command for an official plugin with a destination-bound credential
sentinel. It resolves the selected provider's configured API-key SecretRef
through the normal secret resolver, including file-backed keys, and uses the
provider's model route policy for its HTTPS endpoint on port 443. It supports
OpenAI-compatible Responses and Completions routes. OAuth, auth-profile
references, custom request headers, and custom request transport are unsupported.
This is a private JavaScript-only host binding for bundled and separately
published official plugins, not a third-party plugin API.

```typescript
const { withConfiguredModelEgress } = await import("openclaw/plugin-sdk/secret-egress-runtime");
await withConfiguredModelEgress({ config, provider, model, signal }, async (egress) => {
  // Keep hostEnv on the credential-owning host for the authenticated bridge.
  // Send only sentinel, baseUrl, model, and public caBundle to the remote app.
  await runRemoteAppThroughBridge(egress, signal);
});
```

The callback receives `sentinel`, `baseUrl`, `model`, `allowedHosts`, `hostEnv`,
and the public `caBundle` contents. Supply `onOutput(text, stream)` to receive
live output with resolved credentials redacted, including values split between
chunks; pass the callback's `onOutputChunk` to the command runner. The caller owns its bridge and remote
process, must honor cancellation, and must join both before its callback
settles. Cancellation revokes proxy access immediately; callback completion or
failure revokes access, stops the isolated proxy, and removes its private CA
directory. Credentials and proxy grants never enter the shared secret store.

This is an explicit command-scoped proxy using the existing secret egress
implementation. It does not require enabling or restarting the Gateway's
persistent egress proxy. Import the SDK module only in the command execution
path; importing it alone does not load model or secret runtime code.

## Prepared simple completions

The `openclaw/plugin-sdk/simple-completion-runtime` helpers support preparing a
model once and completing with it repeatedly. Successful preparation retains the
provider resources used by its `model`, `auth`, and `selection` fields. The host
owns those resources, so callers can reuse the result without a disposer:

```typescript
const result = await prepareSimpleCompletionModelForAgent({ cfg, agentId });
if ("error" in result) {
  throw new Error(result.error);
}
const prepared = result;
const response = await completeWithPreparedSimpleCompletionModel({
  model: prepared.model,
  auth: prepared.auth,
  cfg,
  context: { messages },
});
```

Preparation accepts an optional `signal`; cancellation prevents late setup from
returning a usable model. Resource cleanup can continue after the logical error;
host shutdown joins admitted setup and cleanup work. Retained results stay owned
until their host closes, which waits for accepted completion work before releasing
provider resources. Repeated
compatible preparations share the existing generation's resources. A result from
a closed host cannot start another completion; prepare again under the current
host.

## Low-level completions

The `complete` and `completeSimple` helpers from `openclaw/plugin-sdk/llm` accept
an optional fourth `assertCurrent` callback. It runs after transport setup and
immediately before provider dispatch. A thrown error or an aborted
`options.signal` prevents dispatch; the callback stays outside provider options.
Existing three-argument calls remain supported.

The `resolveOpenAIModelReasoningEfforts`, `resolveOpenAIReasoningEffortMap`, and
`resolveOpenAIReasoningEffortMapping` helpers from the same SDK subpath read the
OpenAI model's effort capabilities and configured native mappings.

Native harnesses can use `selectSupportedReasoningEffort` from
`openclaw/plugin-sdk/agent-harness-attempt-runtime` with their validated effort order and
supported efforts. It keeps a supported request, otherwise chooses the next
higher supported effort, or the highest available effort when none is higher.
Backend adapters retain protocol validation and special-mode handling.

## Model namespaces

<AccordionGroup>
  <Accordion title="api.runtime.llm">
    Run a host-owned text completion without importing provider internals or
    duplicating OpenClaw model/auth/base URL preparation.

    ```typescript
    const result = await api.runtime.llm.complete({
      messages: [{ role: "user", content: "Summarize this transcript." }],
      purpose: "my-plugin.summary",
      maxTokens: 512,
      temperature: 0.2,
      reasoning: "high",
    });
    ```

    `maxTokens` and `temperature` are advisory sampling hints. The selected
    provider, CLI, or harness applies them when its transport exposes an
    equivalent control and otherwise may ignore them. They do not weaken the
    execution mode's isolation guarantees.

    To require the configured agent runtime and a literal zero-tool model
    surface, select isolated execution explicitly:

    ```typescript
    const result = await api.runtime.llm.complete({
      messages: [{ role: "user", content: "Return one JSON value." }],
      systemPrompt: "You are a JSON-only function.",
      outputSchema: {
        type: "object",
        properties: { answer: { type: "string" } },
        required: ["answer"],
        additionalProperties: false,
      },
      model: "openai/gpt-6-astra",
      execution: {
        mode: "isolated-agent-runtime",
        authProfileId: "openai:work",
        timeoutMs: 30_000,
      },
    });
    ```

    This mode accepts exactly one user message. Core derives the configured CLI
    or harness owner, starts a fresh context, exposes no model-callable tools,
    and never falls back to direct provider transport. Unsupported runtimes fail
    before inference. `result.execution.owner` reports the selected owner;
    token usage remains absent when a CLI cannot report it.

    `outputSchema` is an advisory native final-output constraint. The host
    forwards a detached JSON-safe snapshot only when it fits within 1 KiB;
    otherwise generation continues without the native constraint. Harnesses
    such as Codex pass the snapshot to transports that support structured
    output. Codex retries with a prompt-level constraint when its transport
    explicitly rejects the schema dialect; other owners may ignore it. Callers
    must still parse and validate the returned value.

    Completion failures expose a stable `code` on the thrown error. Isolated
    callers can distinguish authorization, invalid isolated input, unsupported
    or unavailable runtimes, aborts, timeouts, rejected output, and other
    completion failures without matching message text.

    Provider orchestration can also acquire the configured local-service
    lifecycle before issuing an HTTP request:

    ```typescript
    const lease = await api.runtime.llm.acquireLocalService(
      {
        providerId,
        baseUrl,
        headers,
      },
      signal,
    );
    try {
      // Send and fully consume the provider request.
    } finally {
      await lease?.release();
    }
    ```

    `acquireLocalService(...)` is a stable, generic provider-service SDK
    contract. The host resolves process configuration from
    `models.providers.<providerId>.localService`; callers cannot supply a
    command, arguments, environment, or lifecycle policy. Process spawning,
    readiness, diagnostics, and idle-stop policy remain internal to the host.

    Pass the exact configured provider id and resolved request base URL. Do not
    replace aliases with an adapter id: separate aliases can point at separate
    local GPU hosts. The host rejects endpoints that do not match the configured
    provider base URL, apart from the `/v1` normalization used by Ollama and LM
    Studio adapters. The host owns startup serialization, readiness probes,
    request leases, abort handling, and idle shutdown.

    The helper uses the same simple-completion preparation path as OpenClaw's
    built-in runtime and the host-owned runtime config snapshot. Context engines
    receive a session-bound `llm.complete` capability, so model calls use the
    active session's agent and do not silently fall back to the default agent. The
    result includes provider/model/agent attribution plus normalized token,
    cache, and estimated cost usage when available.

    `usage.costUsd` is omitted when no recorded cost or configured/eligible catalog
    pricing is available. Default-filled zero rates do not establish free usage.
    Explicit operator zero pricing and provider-billed zero totals remain `0`;
    recorded request costs retain their original pricing tiers.

    Direct completions can set `responseFormat` for provider-native constrained
    output. When the provider exposes them, the result also includes the concrete
    `responseModel` and terminal `stopReason`. Security-sensitive callers can set
    `requiredAuthMode: "oauth"`; the host then rejects a selected non-OAuth
    credential before dispatch. Isolated agent-runtime completions reject these
    direct-provider controls before dispatch.

    Set `reasoning` to request a reasoning effort for the selected model. The
    host accepts the canonical thinking levels (`off`, `minimal`, `low`,
    `medium`, `high`, `xhigh`, `adaptive`, `max`, and `ultra`). Direct completions
    map `adaptive` to `medium` and `ultra` to `max`; the selected provider transport
    maps each effort to its supported wire value. Explicit `off` reaches the
    provider's disabled-thinking policy; whether thinking can be disabled depends
    on the selected model and auth route.

    Codex isolated completions pass explicit reasoning levels through the native
    model's supported-effort mapping. When reasoning is omitted, these bounded
    calls keep their low-effort default.

    <Warning>
    Model overrides require operator opt-in via `plugins.entries.<id>.llm.allowModelOverride: true` in config. `plugins.entries.<id>.llm.allowedModels` restricts those overrides; `plugins.entries.<id>.llm.allowedCompletionModels` separately restricts every completion, including host-resolved defaults. For direct completions, a `model@profile` override remains part of the authorized model override. Isolated `model@profile` overrides and `execution.authProfileId` require `plugins.entries.<id>.llm.allowAuthProfileOverride: true`. Cross-agent completions require `plugins.entries.<id>.llm.allowAgentIdOverride: true`.
    </Warning>

  </Accordion>
  <Accordion title="api.runtime.modelConfig">
    Synchronous model-selection policy, without preparing a model or starting a session.

    `resolveDefaultModelForAgent({ cfg, agentId })` resolves the agent's configured default. `resolveAllowedModelRef({ cfg, catalog, raw, defaultProvider, defaultModel, agentId })` resolves a model name or alias against the supplied catalog and agent allowlist, returning `{ ref, key }` or `{ error }`. It does not select or validate an agent runtime; callers that require a particular harness must apply that separate policy.

    `resolveModelRuntimePolicy({ config, provider, modelId, agentId?, sessionKey? })` reads the configured runtime policy. It honors exact agent/default model entries, provider-model entries, provider-wildcard entries, and provider policy in that order. The result includes `policy` and its `source` (`"model"` or `"provider"`) when configured, or an empty object when no policy matches. This lookup does not select an implicit runtime default or check harness availability.

    Use these host operations instead of importing model-selection implementation modules into a plugin's registration entry.

  </Accordion>
  <Accordion title="api.runtime.modelAuth">
    Model and provider auth resolution.

    Synchronous profile operations are also available: `resolveProviderIdForAuth`, `ensureAuthProfileStore`, `resolveAuthProfileOrder`, `listProfilesForProvider`, and `isProviderApiKeyConfigured`. They use the canonical host auth policy. Supply the owning agent directory when reading agent profiles, and use `readOnly: true` and `allowKeychainPrompt: false` for non-interactive profile inspection. Profile stores and resolved credentials must not be logged.

    Capability factories should construct descriptors only. Keep credential inspection and resolution in the callbacks that need them, rather than performing them while registering a provider.

    ```typescript
    const auth = await api.runtime.modelAuth.getApiKeyForModel({ model, cfg });

    // Request-ready auth, including provider runtime exchanges (e.g. OAuth refresh)
    const runtimeAuth = await api.runtime.modelAuth.getRuntimeAuthForModel({ model, cfg });

    const providerAuth = await api.runtime.modelAuth.resolveApiKeyForProvider({
      provider: "openai",
      cfg,
    });
    ```

  </Accordion>
</AccordionGroup>

## Prepared completion SDK compatibility

Prefer `api.runtime.llm.complete` for new plugin code. Existing callers of
`openclaw/plugin-sdk/simple-completion-runtime` can continue to prepare a model
with `prepareSimpleCompletionModelForAgent` and execute it with
`completeWithPreparedSimpleCompletionModel`.

The executor accepts optional `options.headers` and `options.sessionId` fields.
Calls that omit them keep the same call shape. For HTTPS OpenCode endpoints,
a standalone completion gets a fresh opaque `x-opencode-session` routing header
for each invocation. An explicit model or caller routing header suppresses
generation, regardless of header name casing. Caller headers take precedence
over model headers.

A supplied `sessionId` retains its existing provider session and cache behavior.
It also supplies the OpenCode routing header unless an explicit header overrides
it. A generated routing value stays in the header only: it does not create
conversation, transcript, prompt-cache, or WebSocket session ownership. Existing
transport retries reuse the invocation's header; the executor adds no retry policy.

These prepared results have no release method. Their original Gateway or CLI
host retains the model resources until shutdown; standalone callers retain them
for the process lifetime. A closed host rejects new preparation and execution.
Shutdown waits for accepted provider callbacks and cancellation work before
releasing the prepared resources, even when the completion has already returned.
