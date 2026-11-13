---
summary: "What experimental flags mean in OpenClaw and which ones are currently documented"
title: "Experimental features"
read_when:
  - You see an `.experimental` config key and want to know whether it is stable
  - You want to try preview runtime features without confusing them with normal defaults
  - You want one place to find the currently documented experimental flags
---

Experimental features are preview surfaces controlled by config flags. They need more real-world mileage before their shape and behavior become long-lived contracts.

- Off by default unless the feature docs state otherwise.
- Shape and behavior can change faster than stable config.
- Prefer a stable path when one already exists.
- Roll out broadly only after testing in a smaller environment first.

All [plugin APIs](/plugins/sdk-overview#api-stability) are also experimental.
That stability label does not require a Labs switch. Native plugin UI is
available by default for enabled plugins; the existing config-only
[advanced opt-out](/plugins/feature-plugins#enable-custom-plugin-ui) remains
available for user-installed browser code.

## Currently documented flags

| Surface                 | Key                                                                     | Use it when                                                                                                                       | More                                                                                   |
| ----------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Codex harness           | `plugins.entries.codex.config.appServer.experimental.sandboxExecServer` | You want native Codex app-server 0.143.0 or newer to target an OpenClaw sandbox-backed exec-server instead of disabling Code Mode | [Codex harness reference](/plugins/codex-harness-reference#sandboxed-native-execution) |
| Code Mode               | `tools.codeMode.enabled`                                                | You want compact code-orchestrated access to a hidden OpenClaw tool catalog                                                       | [Code Mode](/tools/code-mode)                                                          |
| Cloud workers           | `cloudWorkers.desktop`                                                  | You want to watch or control desktop-capable cloud worker environments from the Control UI                                        | [Cloud device desktop](/gateway/cloud-workers#desktop-interactive)                     |
| Templates               | `gateway.controlUi.experimental.templates`                              | You want to explore and add official ClawHub agents from the Control UI                                                           | [Templates](/cli/templates)                                                            |
| This computer’s desktop | `desktop.host.enabled`                                                  | You want to watch or control the Gateway host through its VNC or Screen Sharing server                                            | [Desktop](/gateway/configuration-reference#desktop)                                    |
| OpenClaw ID             | `gateway.openclawId.enabled`                                            | You want to open this claw from your other devices through OpenClaw ID, without opening a port                                    | [OpenClaw ID remote access](#openclaw-id-remote-access)                                |
| Speech bubbles          | `gateway.controlUi.experimental.chatBubbles`                            | You want to try conversation bubbles and compact activity; Home defaults on while the lab is enabled                              | [Chat](/web/control-ui/chat)                                                           |
| Tool Search             | `tools.toolSearch.enabled`                                              | You want to control the global Tool Search default, which is enabled                                                              | [Tool Search](/tools/tool-search)                                                      |

## Control UI Labs

Open **Settings → Labs** to manage experiments that have a
Control UI switch. Enabling or disabling a lab patches the saved Gateway
config immediately without restarting the Gateway.

Labs includes Speech bubbles, Decision assistance, Code Mode, Tool Search for all models,
Templates, This computer’s desktop, OpenClaw ID remote access, and Cloud device desktop. Under the default reload mode,
desktop availability updates in connected Control UI pages. Code Mode and Tool
Search changes take effect for future agent runs. The Cloud device desktop lab
controls access to existing desktop-capable workers; changing a profile’s
`settings.desktop` affects only newly provisioned workers.

<a id="advisor" />Advisor has graduated from Labs. It stays off by default;
turn it on in **Settings → Plugins → Advisor**. See
[Advisor](/plugins/reference/advisor).

Custom plugin UI has graduated from Labs. Enabled plugins can load native UI
by default, while an existing explicit
`gateway.controlUi.experimental.customPlugins: false` stays off. The historical
config path remains an advanced opt-out, not a Labs requirement. It does not
disable bundled views or backend operations.

Templates is off by default. Turning it on permits official starter discovery and
Add in Agents, Gateway catalog/Add methods, and local CLI Add. Add creates an
ordinary agent and installs its requirements; repeating Add creates another
agent. Turning the switch off blocks new Add operations, but existing agents
continue running. Local project authoring and inspection do not require the
switch. An Add already admitted before the switch changes can finish safely.

Code Mode remains disabled until you turn on its Labs switch or explicitly set
`tools.codeMode` to `true` or `"auto"`. The Labs switch writes `"auto"`, so it
engages only for models marked as preferred Code Mode performers; it does not
force Code Mode on for every model.

Tool Search is enabled by default when `tools.toolSearch` is unset.
Turning its Labs switch off disables the global default; turning it on restores
that default.

## Decision assistance

This opt-in enables experimental conversational tool filtering in the built-in
OpenClaw runtime. Before an eligible user turn, the configured Decision provider
judges whether the request needs tools. A conversational result can omit optional
tools for that turn. Other harnesses keep their normal tools and perform no
automatic prefilter inference. The switch does not select a provider, provision
credentials, download models, or enable unrelated consumer modes.

The switch and manually authored config use the same global Boolean:

```json5
{
  agents: {
    defaults: {
      experimental: { decisionAssistance: true },
    },
  },
}
```

The default is **off**. Only explicit `true` opts in; omission, `false`, or
unrelated experimental options do not. Objects such as
`decisionAssistance: { enabled: true }` are invalid. Turning the Labs switch off
removes its override and restores off, preserving model selections and sibling
settings. There is no browser-local preference.

Saved opt-in is not per-agent eligibility. Automatic consumers also need
an effective [Decision model](/concepts/decision-models) for their owning agent.
An unset agent model inherits `agents.defaults.decisionModel`; an explicit empty
`agents.entries.<id>.decisionModel` disables eligibility for that agent. A model
selection alone never opts in. The global switch does not mean every agent is
eligible, nor that a configured provider is ready. Without a model, the on
preference remains saved and no automatic Decision inference can run.

The explicit `decision_evaluate` tool is independent of Labs under its normal
model-selection and tool-policy contract. Labs does not gate the shared Decision
runtime or provider registration, and it never grants permission for actions.

### Core consumer contract

Core implementations can import
`isDecisionAssistanceEligible(config: OpenClawConfig, agentId: string): boolean`
from `src/agents/decision-assistance.ts`. Supply prepared config and the trusted
owning agent ID, not a model-provided ID. The helper returns exactly
`decisionAssistance === true && resolveDecisionModelSetting(config, agentId) !== undefined`.
It performs no provider checks, secret resolution, file reads, network requests,
model loading, or inference, and returns no provider-readiness diagnostics.
This is an internal foundation boundary, not a new plugin SDK surface.

For example, at an automatic consumer boundary:

```ts
import { isDecisionAssistanceEligible } from "./decision-assistance.js";

if (!isDecisionAssistanceEligible(preparedConfig, owningAgentId)) {
  return existingBaseline;
}
// Separately check this consumer’s explicit mode, harness support, and authority
// before loading its optional implementation or preparing evaluation evidence.
```

Use the existing config publication/refresh lifecycle, not file polling.
Consumers check opt-in again at Decision provider dispatch, after awaited
preparation. Disabling assistance stops subsequent evaluations from starting;
already-dispatched evaluations may finish, including provider preparation and
network I/O, and their results may still be used. Model selection, live authority,
cancellation, deadlines, and provider/credential validity remain independently
checked. This helper is not an authority token or a cancellation owner.

### Conversational tool filtering

**Upgrade behavior:** the existing saved `decisionAssistance: true` is opt-in
intent for future automatic Decision experiments. When this consumer is installed,
it can run on eligible turns for an agent with an effective Decision model; the
preference does not select a new provider or grant tool authority. Operators who
do not want automatic evaluation can turn the preference off or clear that
agent’s Decision model. The transferred evidence and costs are described below.

The prefilter sends the complete current request and a rule-based, bounded
projection of recent conversation to the owning agent’s configured Decision
provider. It retains the nearest complete user/assistant exchange and, when it
fits, one additional exchange in chronological order. Resolved output from
ordinary `before_prompt_build` hooks is also sent verbatim in labeled fields when
present: `prependContext`, `appendContext`, `systemPrompt`,
`prependSystemContext`, and `appendSystemContext`. Two internal text bounds apply:

- The latest request plus retained user/assistant exchange text is limited to
  **6,000 UTF-16 code units**. Only whole older exchanges may be omitted.
- That conversation text plus all five verbatim hook-field values must fit
  **8,000 UTF-16 code units** in total. Oversized hook fields are not truncated.

These are JavaScript string-length bounds on the evidence text, not a bound on
serialized JSON, UTF-8 wire bytes, or tokens. Field names, JSON escaping, omission
facts, tool-result counts, and the fixed rubric add serialization overhead.
The current request and essential context are never cut to force classification;
oversized, malformed, missing, or otherwise unsuitable essential context retains
normal tools. A genuinely fresh session is
evaluated using the current request alone. Existing incomplete history is not
treated as a fresh session; missing referents and uncertainty must retain tools.

Only user-visible text, counts of returned/failed tool calls, and the listed
resolved ordinary hook fields are secondary evidence. Other system/developer
instructions, hidden reasoning, raw tool arguments or results, internal-event
envelopes, and media are not sent. Tool return counts do not assert that an
action succeeded. Hosted providers receive this bounded evidence and can incur
charges; local providers keep inference local.
Classification adds work before the primary model request and is not a guaranteed
latency improvement.

The current internal budget is 500 ms, not a configuration option. One existing
Decision batch asks two independent Boolean questions: whether the latest request
has an unresolved contextual reference, and whether fulfilling it requires tools
in the next response. Both probabilities must be below 0.35 to omit optional tools. The context question
checks for a referent needed to fulfill the current request, not merely for
additional background. A conversational acknowledgment of completed work that
requests nothing further does not itself require a missing referent.
Missing, affirmative, or uncertain answers preserve tools. These are probabilities
of yes, not degrees of tool use or separate confidence values.

The structured state names the latest request, chronological recent exchanges,
and facts about omitted older conversation and raw tool payloads. Each question
references those fields explicitly. Earlier mentions of tools do not by themselves
request new actions, and omitted older history alone does not veto filtering.
This follows [TypeSafe atomic Noul guidance](https://docs.typesafe.ai/primitives/noul)
while using the provider-neutral Decision contract; it makes no provider-specific
requests or calibrated-correctness guarantees. There is
no model-aware input estimator, automatic trimming retry, or second provider.
Ordinary unavailable results, including a deadline or actual provider input
rejection, keep the normal tool surface. A caller-budget deadline does not count
as a provider outage or open the shared health circuit, so repeated optional
prefilter timeouts do not disable explicit `decision_evaluate` requests. Genuine
provider transport, authentication, and rate-limit failures retain their shared
health handling; in-flight work still owns its concurrency slot until it settles.
Cancellation, closed authority, and contract errors
remain errors rather than starting fallback work. Cold model loading may exceed
the budget. Classifier estimates are not guarantees that every action request
will retain its optional tools.

Filtering skips raw checks, continuations, internal events, queued steering,
orphan repair, pending tool work, hook-set `toolsAllow` restrictions, and
authority-dependent prompt-build hooks that require finalized tools. Ordinary
prompt-build hooks run normally and their resolved fields can inform the Decision
evaluation without changing the public hook contract. It no longer rejects a
turn merely because prior assistant or tool messages exist. Complete contextual
approvals remain action requests, while a conversational acknowledgment can omit
optional tools on later turns. It uses the existing host tool policy, preserves
already-required tools without granting denied tools, and keeps submitted schemas,
discovery, and callability aligned.
Each subsequent turn starts from its own normal tool baseline. Opt-out or a changed
Decision model does not withdraw a restriction from an already-dispatched
evaluation. Those settings apply to the next evaluation; live permissions still
govern the current turn. No historical transcript is rewritten and no native
thread is recreated.

With DEBUG logging enabled for the embedded runner, a safe record at the first
foreground primary dispatch reports decision status/reason, decision latency,
context counts and omission flags, visible tool counts, required tools retained,
and the before/after normalized tool-definition JSON UTF-16 character difference
(`name`, `description`, and `parameters`). Tool Search and Code Mode count only
the actually exposed controls/direct tools, including their descriptions—not
every hidden catalog schema. This schema-only metric is not provider wire bytes,
full prompt savings, tokens, cost, or proof that a provider accepted the request.
Tool-related prompt guidance is reported as unmeasured. Unknown measurements
remain unknown, not zero. DEBUG-off avoids the extra definition serialization.
No conversation, tool payloads, full schemas, or credentials are logged by this
record; existing logging and trace-correlation controls apply.

## OpenClaw ID remote access

OpenClaw ID remote access is off by default (`gateway.openclawId.enabled`).
While it is off the Gateway starts no tunnel child, opens no tunnel sockets and
makes no calls to OpenClaw ID, Discovery or relays, and the `openclawId.*`
methods refuse every request. Turning it off also stops any Discovery request
that was still being prepared. Turn it on in **Settings → Labs → OpenClaw ID
remote access**, or in config:

```json5
{
  gateway: {
    openclawId: {
      enabled: true,
      relayUrl: "https://relay.example.com/",
      // Needed to turn on remote access for a claw from the account menu
      // (you sign in with OpenClaw ID first, which needs clientId):
      issuerUrl: "https://id.example.com/api/auth",
      clientId: "<public PKCE client id>",
      discoveryUrl: "https://discovery.example.com",
      loaderDomain: "claws.example.com",
    },
  },
}
```

No service URL has a production default yet; the Gateway reports
`unconfigured` until `relayUrl` is set. Changes apply without a restart. See the
[`openclawId` configuration keys](/gateway/config-gateway) for the full list.

Labs only switches the feature on or off. Everything else lives outside Labs:

- **Account menu** (your avatar, bottom left of the sidebar): **Sign in with
  OpenClaw ID**, **Turn on remote access**, **Your devices**, **Copy claw link**
  and **Sign out of OpenClaw ID**, depending on your connection and setup state.
- **Access**, under **Pages**: the **Remote access** page from the bundled
  `openclaw-id-access` plugin (enabled by default). It shows who may reach this
  claw through OpenClaw ID; its **People** section lets you invite someone,
  approve or deny their request, and remove members. Use an approved owner
  browser to change access. Devices paired with this Gateway are in
  **Settings → Devices**.
- **Your devices**, in the account menu: view approved owner browsers and choose
  **Remove access** for a browser. The confirmation lists any other devices that
  will also lose access. They disconnect immediately; use another approved owner
  browser or your recovery kit to restore access.
- **Sign out of OpenClaw ID** on a remote browser ends its account session and
  revokes the Gateway tokens issued to it, but the browser stays approved.
  Signing back in on the same browser reconnects with the access it was
  approved for, without a new device approval. Asking for more access than
  that still needs approval.
- **Settings → Devices** and `openclaw devices list` mark browsers that connect
  through OpenClaw ID and link to **Access**. They can't be removed or have
  their tokens revoked as devices. To end someone's access, remove them on
  **Access**; to remove one of your own owner browsers, use **Your devices** in
  the account menu. Nodes and other devices are managed as before.
- There is no owner reset in this version: a claw keeps the recovery kit it was
  linked with, so store the kit safely.
- To move a claw to new connection keys (a lost or leaked key file, a new computer
  without the key files, or routine rotation), run `openclaw id rebind` on the
  computer that runs it, with its recovery kit. Devices, people, nodes and invites
  stay ([CLI](/cli/id)).

### Sign in with OpenClaw ID

Sign-in uses the public client `clientId`. Where it works depends on how the
Control UI reaches the Gateway:

- **On the Gateway machine (direct loopback):** an OpenID Connect authorization
  code flow with PKCE, in a popup. The Gateway builds the authorization URL and
  redeems the code, because the issuer does not serve CORS; it keeps nothing but
  the short-lived pending sign-in. The popup returns to
  `<Control UI origin>/openclaw-id/callback`, so register that redirect for the
  client (`http://127.0.0.1/openclaw-id/callback` matches any loopback port).
- **Through a personal sign-in** (Tailscale Serve, Cloudflare Access or another
  trusted proxy, an enterprise principal: any connection whose profile comes from
  a verified identity of its own): the issuer cannot redirect to that origin, so the
  Gateway runs a device sign-in (RFC 8628). The Control UI shows a code; you open
  OpenClaw ID, sign in and confirm it, and the Gateway polls until you do. The
  issuer must offer the device grant to the client.
- Shared token or password connections, members and owner devices over the
  OpenClaw ID tunnel, and connections without a personal profile cannot sign in.

The browser keeps the account and its ID token until the token expires or you sign
out. Signing in only proves which OpenClaw ID account the browser holds; on its own
it grants nothing.

### Link OpenClaw ID to your profile

Through a personal sign-in, **Settings → Profile → Identity → OpenClaw ID → Link**
runs the same device sign-in and records the account on your profile. Both sides are
proven on one connection, so there is no "who are you?" picker. Owner devices of the
claw's OpenClaw ID owner account then arrive as you (your name, sessions, personal
instructions and My GitHub) instead of the shared owner. Their owner authority still
comes from each device's certificate, and linking grants or removes nothing.

- One profile per account: linking an account already linked to another profile, or to
  a member's profile, is refused. Merging profiles in **Users** carries the link.
- **Unlink** returns owner devices to the shared owner on their next connection.
  Sessions they already created are not rewritten. While signed in on the Gateway machine, **Turn on remote access**
  gets its link code from your account instead of asking you to paste one.

### How the tunnel reaches the Gateway

- The Gateway supervises one **tunnel child** process. The child owns the iroh
  endpoint key (`<state dir>/openclaw-id/endpoint.key`, mode 0600, created on
  first start). It runs
  at a lower CPU priority, restarts with a 1 to 30 second backoff, is restarted
  gracefully above 512 MB RSS, and stops with SIGTERM then SIGKILL after 2
  seconds. If the iroh binding cannot load on this platform, the Gateway reports
  remote access unavailable and keeps running.
- Once a claw is linked, its server binding names the endpoint key and the
  Gateway key (`<state dir>/openclaw-id/gateway.key`), and neither is ever
  created again. If either file is missing or holds another key, for example
  after a restore that skipped the key files, remote access is off and status
  reports `keys_missing` or `key_mismatch`. Nothing is published or dialed with
  another key. The Gateway itself keeps running, so everything on this computer
  works as before. To bring remote access back, restore the original key files,
  then restart the Gateway, or move the claw to new keys with its recovery kit
  on this computer: `openclaw id rebind` ([CLI](/cli/id)).
- The child admits a device only if the Gateway's membership lists the
  device's endpoint key, and checks that before accepting any stream. Until a
  claw is linked, nobody is admitted.
- The child proxies each stream to a private Gateway ingress: a Unix socket
  only the Gateway's user can open, plus a per-boot proxy token it receives over
  the supervisor's IPC channel. It strips client forwarding and identity headers
  and passes the device key it authenticated in the QUIC handshake.
- Requests that come through this ingress are always treated as relayed, never
  as direct loopback, even though they arrive on the local host. Linking a claw
  and other root ceremonies are allowed only on direct loopback.

<a id="make-a-claw-reachable" />

### Turn on remote access

With the lab on, sign in with OpenClaw ID from the account menu, then choose
**Turn on remote access**. It works only in OpenClaw on the computer that runs
this claw (direct loopback). If setup asks for a **Link code**, get one from the
**Add a claw** page at `https://claws.<loaderDomain>/link` and paste it into setup:

1. The Gateway creates the claw id and its signing key, and reports the tunnel's
   endpoint key.
2. The browser creates a recovery kit (`OCK1-…`) and derives the owner root key
   from it. You must confirm that you saved the kit before you can continue.
3. The browser creates an owner device key for this origin, and the owner root
   signs that device's certificate and the server binding (claw id, hostname
   `<name>-<account tag>.<loaderDomain>` as Discovery assigned it, endpoint key,
   Gateway key).
4. The Gateway pins the owner root's fingerprint and admits the owner device.
   The kit secret and root key never leave the browser and are dropped as soon
   as the statements are signed.
5. With a link code, the Gateway registers the claw with
   Discovery and publishes its descriptor and membership snapshot. Without one,
   the claw is linked locally and can be published later.

### Membership

The Gateway is the membership authority. It stores the pinned owner root, the allowlist
of owner devices and members, invites and a sequence number in its state
database. Owner devices send membership changes directly to the Gateway
(over the tunnel or loopback); Discovery only mirrors signed snapshots and
carries invite redemption requests, root-signed statements and revocations.
When a member or device is removed, the tunnel child closes its connections,
the Gateway closes its sessions and invalidates device tokens bound to its key,
cancels its active runs (transcripts are kept up to the cut), and publishes a
new snapshot.

## Local model lean mode

Lean mode is an advanced troubleshooting override, configured outside Labs.
Its existing `experimental.localModelLean` keys remain supported. See
[Local model lean mode](/gateway/local-models#local-model-lean-mode) for capability
restrictions, config examples, and recovery guidance.

- <a id="why-these-tools" />[Why these tools](/gateway/local-models#why-these-tools)
- <a id="when-to-turn-it-on" />[When to turn it on](/gateway/local-models#when-to-turn-it-on)
- <a id="when-to-leave-it-off" />[When to leave it off](/gateway/local-models#when-to-leave-it-off)
- <a id="enable" />[Enable](/gateway/local-models#enable)

## Experimental does not mean hidden

An experimental feature should say so plainly in docs and in the config path itself, not hide behind a stable-looking default knob.

## Related

- [Features](/concepts/features)
- [Release channels](/install/development-channels)
