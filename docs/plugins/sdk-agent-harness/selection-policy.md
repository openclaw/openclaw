---
summary: "How OpenClaw picks a harness after provider and model resolution, and why most harnesses also register a provider"
read_when:
  - You need to know when `auto` selects a plugin harness
  - A surprising harness was selected and you are debugging it
  - You are pairing a harness with a provider plugin
title: "Agent harness selection policy"
sidebarTitle: "Selection policy"
---

How OpenClaw chooses a harness after provider and model resolution, what a failure does to the model-fallback chain, and why a harness normally ships alongside a provider plugin. Part of the [Agent harness plugins](/plugins/sdk-agent-harness) reference.

## Selection policy

OpenClaw chooses a harness after provider/model resolution:

1. Model-scoped runtime policy wins.
2. Provider-scoped runtime policy comes next.
3. `auto` asks registered harnesses if they support the resolved effective
   route. Provider/model prefixes alone never select a harness.
4. If no registered harness matches, OpenClaw uses its embedded runtime.

Plugin harness failures surface as run failures. In `auto` mode, embedded
fallback only applies when no registered plugin harness supports the resolved
provider/model. Once a plugin harness has claimed a run, OpenClaw does not
replay that same turn through another runtime, because that can change
auth/runtime semantics or duplicate side effects.

A failure that occurs before the harness starts any model work may use
`AgentHarnessPreflightError` from
`openclaw/plugin-sdk/agent-harness-runtime`. The default error remains terminal
for the whole model-fallback chain. Pass `{ scope: "harness" }` only when the
failure is local to the selected harness and retrying another model on that same
harness would repeat it. OpenClaw records the actual selected harness at the
attempt boundary, skips only later candidates proven to use that harness, and
runs any differently owned candidate through its normal runtime and policy
checks. Plugins opt into the scope but never name the harness owner on the
error. Do not use harness scope after a request or tool action may have produced
side effects.

Configured runtime policy remains authoritative about the desired runtime.
A durable native harness pin retains its transcript owner; an observed harness
on a plugin-owned concrete model chat does not become a pin, even when model
selection is locked. For concrete-model execution, neither a request nor a pin
makes an incompatible route compatible: the harness must support the prepared
facts, declare the exact-request OpenClaw fallback, or fail closed.
[Bound native session ownership](/plugins/sdk-agent-harness#bound-native-session-ownership) separately
identifies sessions whose verified native connection owns model and auth, so
unrelated outer route metadata does not replace that connection.

Next-turn metadata uses the registered support decision and retains its
model/provider/session source. Historical producer observations do not pin the
next turn. Projection never loads a harness or reads credentials.
Prepared status is explicit: missing `runtimePolicy` stays undeclared instead
of being inferred from whichever transport fields happen to be present.
When harness-owned auth leaves multiple physical routes unresolved, the
prepared support fact is the intersection of their compatible runtime ids and
reports request overrides if any candidate has them. One undeclared candidate
therefore makes native compatibility empty; `preparedAuth.source: "harness"`
is an auth owner, not permission to infer route support.

If the selected harness is surprising, enable `agents/harness` debug logging
and inspect the gateway's structured `agent harness selected` record: it
includes the selected harness id, selection reason, runtime/fallback policy,
and, in `auto` mode, each plugin candidate's support result.

The bundled Codex plugin registers `codex` as its harness id. Core treats that
as an ordinary plugin harness id; Codex-specific aliases belong in the plugin
or operator config, not in the shared runtime selector.

## Provider plus harness pairing

Most harnesses should also register a provider. The provider makes model refs,
auth status, model metadata, and `/model` selection visible to the rest of
OpenClaw. The harness then claims that provider in `supports(...)`.

The bundled Codex plugin follows this pattern:

- preferred user model refs: `openai/gpt-5.6-sol`
- compatibility refs: legacy `codex/gpt-*` refs remain accepted, but new
  configs should not use them as normal provider/model refs
- harness id: `codex`
- auth: prepared OpenAI route/profile policy for concrete requests; verified
  native-auth bindings use their native connection
- app-server request: OpenClaw sends the bare model id to Codex and lets the
  harness talk to the native app-server protocol

The Codex plugin is additive. With runtime policy unset or `auto`, OpenAI may
select Codex only when its provider-owned route contract declares `codex`
compatible: an exact official HTTPS Platform Responses or ChatGPT Responses
route with no authored request override. The `openai/*` prefix alone never
selects Codex. Custom endpoints, Completions adapters, and authored request
behavior stay on OpenClaw. Plaintext official HTTP endpoints are rejected. Older `codex/gpt-*`
refs remain compatibility inputs. See
[OpenAI implicit agent runtime](/providers/openai/runtimes#implicit-agent-runtime).

For operator setup, model prefix examples, and Codex-only configs, see
[Codex Harness](/plugins/codex-harness).

The Codex plugin enforces the minimum app-server version documented in
[Codex Harness](/plugins/codex-harness). It checks the initialize handshake and
blocks older, malformed, or unversioned servers. Admission permits startup to
continue; it does not prove later runtime or capability operations will succeed.
