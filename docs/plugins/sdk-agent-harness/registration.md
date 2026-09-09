---
summary: "Register an AgentHarnessV2, plus the optional isolated-completion and delegated-execution capabilities"
read_when:
  - You are writing the plugin entry that calls `api.registerAgentHarness`
  - You are implementing `runIsolatedCompletionV2`
  - You need to let a trusted plugin execute a session your harness owns
title: "Register an agent harness"
sidebarTitle: "Registration"
---

The registration call itself, and the two optional capabilities a registered harness can add: one fresh tool-free inference call, and consent for a trusted delegate to execute an existing model-locked session. Part of the [Agent harness plugins](/plugins/sdk-agent-harness) reference.

## Register a harness

**Import:** `openclaw/plugin-sdk/agent-harness`

```typescript
import type { AgentHarnessV2 } from "openclaw/plugin-sdk/agent-harness";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

const myHarness: AgentHarnessV2 = {
  id: "my-harness",
  label: "My native agent harness",

  supports(ctx) {
    const routeSupportsHarness =
      ctx.modelProvider?.runtimePolicy?.compatibleIds.includes("my-harness") === true;
    const canReproduceRequest = ctx.modelProvider?.requestTransportOverrides !== "present";
    return ctx.provider === "my-provider" && routeSupportsHarness && canReproduceRequest
      ? { supported: true, priority: 100 }
      : { supported: false, reason: "effective route is not harness-compatible" };
  },

  async runAttempt(params) {
    // Start or resume your native thread.
    // Use params.prompt, params.tools, params.images, params.onPartialReply,
    // params.onAgentEvent, and the other prepared attempt fields.
    return await runMyNativeTurn(params);
  },
};

export default definePluginEntry({
  id: "my-native-agent",
  name: "My Native Agent",
  description: "Runs selected models through a native agent daemon.",
  register(api) {
    api.registerAgentHarness(myHarness);
  },
});
```

`authBootstrap` is intentionally absent from this generic example. Add
`authBootstrap: "harness"` only when the harness meets the
[harness-owned auth bootstrap contract](/plugins/sdk-agent-harness/core-ownership#harness-owned-auth-bootstrap).

### Isolated completion

The optional `runIsolatedCompletionV2(params)` capability serves product paths
that require one fresh prompt-only inference call with a literal empty
model-callable tool surface. Core passes provider and model ids, prompts,
deadline controls, and one prepared `authorization`:

- `owner: "host"` contains the exact transport `model` and resolved `auth`.
- `owner: "harness"` contains the prepared runtime auth plan and a credential
  snapshot restricted to the single profile selected for that call. Core owns
  automatic fallback order and invokes the harness separately for each candidate.

Each new isolated completion uses the configuration and agent/workspace directories
of its admitted runtime generation. Explicit model, auth-profile, and runtime
selections remain fixed while that generation is prepared.

Host-authorized calls must use the supplied model and credential without substitution.
Bundled host-authorized harnesses share one host-prepared completion helper that
preserves the exact route, deadline, sampling options, and empty tool surface.
Harness-authorized calls may resolve only the supplied prepared
route and scoped profiles, or the harness's native account when the plan leaves
auth to the harness. The harness must not switch routes, reuse a native thread,
attach tools, invoke agent lifecycle hooks, or deliver output.

When supplied, call `params.assertCurrent()` after preparation awaits and
immediately before each credential handoff, inference request, or process start,
including retries.
It revalidates the caller's live authority and expires when the completion ends.
A thrown assertion ends execution; do not treat it as a credential failure or
retry with another profile. Continue to honor `abortSignal`; cleanup must remain
available after authority expires.

Return `{ assistant: AssistantMessage }`. Core accepts only terminal text/thinking
content with a `stop` or `length` stop reason; tool calls, failed stops, and empty
output are rejected. Title requests set `outputTextPolicy: "strict-visible"`:
keep reasoning separate without recovering ambiguous reasoning as visible text;
an empty visible result is valid. The host-prepared helper maps this policy to
strict parsing before recovery. Omission preserves ordinary recovery behavior.
CLI-backed title calls also allow clean empty output without a silent-reply token;
ordinary CLI calls still reject empty responses.
Older external harnesses may ignore the policy; a final title filter cannot
restore provenance that a harness already discarded, so this is not a universal
reasoning-privacy guarantee. If the harness cannot enforce isolation, omit the capability.
Callers that require isolated completion then fail closed before invoking that
harness; OpenClaw does not replay the request through another runtime.
Plugin callers request isolated execution through
`api.runtime.llm.complete({ execution: { mode: "isolated-agent-runtime" } })`;
the harness callback is the provider-side enforcement SPI, not a second caller
API.

The legacy `runIsolatedCompletion(params)` host-auth-only capability is
deprecated and remains available for external plugins through 2026-10-12.
Implement V2 for harness-owned or native authentication; OpenClaw never invents
a host credential when only the legacy capability is present.

Native agent servers often have ambient built-in tools even when OpenClaw sends
an empty tool list. Disable and attest those native capabilities for the fresh
turn, use a separate transport that can serialize a true zero-tool request, or
leave the capability unsupported.

Audit evidence follows the same boundary. OpenClaw can record registered plugin
ownership and run admission, but it cannot claim an external native side effect
from an ACP update or transcript. A side effect wholly inside that runtime is
`unsupported` unless an adapter invokes an OpenClaw-owned callback before the
action. Do not reconstruct the callback from native tool status events.

### Delegated execution

A harness owner may set `delegatedExecutionPluginIds` to the ids of trusted
plugins that need to execute an existing model-locked session, such as a voice
transport continuing a Codex-backed conversation. This is static owner consent,
not a core allowlist. Keep it narrow.

Delegates receive only work admission and embedded execution. OpenClaw requires
the exact stored session key, store path, and session id; `modelSelectionLocked:
true`; and matching `agentHarnessId` and `agentHarnessRuntimeOverride` values.
The run is then scoped through the harness owner. Session creation, patching,
reset, deletion, archive, and Gateway mutation remain owner-only.
