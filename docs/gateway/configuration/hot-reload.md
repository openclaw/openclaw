---
summary: "How the Gateway applies config snapshots, which changes hot-apply, and which need a restart"
title: "Config hot reload"
sidebarTitle: "Config hot reload"
read_when:
  - A config edit did not take effect and you need to know why
  - Deciding between hybrid and off reload modes
  - Checking whether a specific key hot-applies or forces a restart
---

## Config hot reload

The Gateway applies revisioned config snapshots automatically. Most settings do
not need a manual restart. `~/.openclaw/openclaw.json` remains the config source,
including JSON5, `$include`, and environment substitutions.

Writes made through the running Gateway publish their committed snapshot
directly to the reload owner. They do not wait for a file-watcher event or its
debounce window. Runtime consumers keep reading the last successfully applied
snapshot until the replacement transaction commits. The log records the
accepted source revision and whether it came from a Gateway write or a file edit.
Later hot-reloadable writes do not erase a committed restart requirement while
its application is pending.

Direct file edits are treated as untrusted until they validate. The source's file adapter waits
for editor temp-write/rename churn to settle, reads the final file, and rejects
invalid external edits without rewriting `openclaw.json`. OpenClaw-owned config
writes use the same schema gate before writing (see [Strict validation](/gateway/configuration#strict-validation)
for the clobber/rollback rules that apply to every write).

The adapter also watches included files and follows editor rename-replace writes.
All reload consumers share the snapshot for each observation; a filesystem echo
of a Gateway write keeps that write's application receipt and restart intent.
A write publication also reconciles file edits already observed during its
finalization, so it cannot discard a pending external change.
Invalid edits leave the last good runtime active. Restart reads the same config
files through the normal startup validation and recovery path; source revision
numbers are local to the running Gateway.

If you see `config reload skipped (invalid config)` or startup reports `Invalid
config`, inspect the config, run `openclaw config validate`, then run `openclaw
doctor --fix` for repair. See [Gateway troubleshooting](/gateway/troubleshooting#gateway-rejected-invalid-config)
for the checklist.

A live change that selects a workspace with retired setup state is also rejected,
with an `openclaw doctor --fix` hint. The Gateway keeps its last-good runtime.
Gateway-managed writes, including `config.set`, reject the candidate before
persistence; hand edits and writes from a separate CLI process can remain on disk
even though the watcher refuses to activate them. Stop the Gateway and, if the
write was rejected before persistence, save the intended workspace path while
it is stopped. Then run [`openclaw doctor --fix`](/cli/doctor) and restart.
Reload never migrates workspace state.

### Reload modes

| Mode                   | Behavior                                                                                                                                |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **`hybrid`** (default) | Applies hot-reloadable settings. Automatically restarts when required.                                                                  |
| **`off`**              | Keeps watching and validating config. Passive runtime changes wait for a manual restart; explicit plugin lifecycle actions still apply. |

```json5
{
  gateway: {
    reload: { mode: "hybrid" },
  },
}
```

The earlier `hot` and `restart` modes are retired; [`openclaw doctor --fix`](/cli/doctor) maps both to `hybrid`. Reload debounce is no longer configurable and runs behind a built-in default.

### What hot-applies vs what needs a restart

Reload planning classifies each changed path as one of three outcomes:

- **Gateway restart (`restart`)**: restart the Gateway process.
- **Hot reload (`hot`)**: apply the change while keeping the Gateway process
  running. This can include restarting the owning subsystem, such as a channel,
  cron, or heartbeat.
- **No reload action (`none`)**: update the runtime config snapshot without
  scheduling a reload action for that path. Consumers that read the current
  config can observe the new value on a later read.

In `hybrid` mode, Gateway restarts happen automatically when required. The longest
matching config prefix determines the outcome. Rules supplied by a plugin apply
only while that plugin is loaded; a path that matches no rule defaults to a
Gateway restart.

By default, changing `agents.defaults.mediaMaxMb` restarts channel runtimes so their inherited
attachment limits take effect together. Automatic reloads preserve manually
stopped accounts; use an explicit channel start to resume those accounts.

Model runtime selection keeps your authored settings separate from catalog defaults.
Hot reload and secrets reload preserve that distinction: catalog compatibility
metadata does not become a custom request override that switches a native runtime
back to OpenClaw.

Changing `session.store` does not migrate conversations. Queued notifications
bound to the previous physical store end with a recorded `store-replaced` outcome.
Pending child-result delivery is suspended while the result and completed task
remain available for explicit recovery; selecting the old store again does not
automatically re-arm that delivery.
Replacement and in-process restart that keep the same store preserve queued
notification handoff.

| Category                  | Fields                                                                                                                                                                                                                                                             | Gateway restart needed?                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| Channels                  | `channels.*`, `web` (WhatsApp)                                                                                                                                                                                                                                     | Depends on setting and loaded plugin                                                           |
| Agent & models            | `agents`, `models`, `auth.order`, `auth.profiles`, `broadcast`, `worktreeRoot`, `worktreeAcceleration`                                                                                                                                                             | No                                                                                             |
| Automation                | `hooks`, `cron`, `agents.defaults.heartbeat`                                                                                                                                                                                                                       | No (reloads the owning subsystem)                                                              |
| Sessions & messages       | `session`, `messages`                                                                                                                                                                                                                                              | No                                                                                             |
| Tools & media             | `tools`, `skills`, `mcp` except Apps listener settings, `audio`, `talk`, `tts`, `memory.citations`, `attachments.ttlHours`                                                                                                                                         | No                                                                                             |
| Plugin config             | `plugins.entries.*`, `plugins.allow`, `plugins.deny`, `plugins.enabled`, `plugins.slots`, `plugins.load`, legacy `plugins.installs`                                                                                                                                | No (reloads plugin runtime by default)                                                         |
| UI & misc                 | `ui`, `logging`, `identity`, `bindings`, `surfaces`                                                                                                                                                                                                                | No                                                                                             |
| Approval & install policy | `approvals.exec`, `approvals.plugin`, `security.installPolicy`, `security.audit.suppressions`                                                                                                                                                                      | No (subsequent operations)                                                                     |
| Diagnostics & ACP         | `diagnostics.flags`, `diagnostics.cacheTrace.enabled`, `acp`                                                                                                                                                                                                       | No (subsequent operations)                                                                     |
| Updates & telemetry       | `update.checkOnStart`, `update.channel`, `update.auto.enabled`, `telemetry.enabled`, `telemetry.consentedAt`                                                                                                                                                       | No (next check)                                                                                |
| Hosted URLs               | `gateway.publicOrigin`, `mcp.apps.sandboxOrigin`                                                                                                                                                                                                                   | No (new URLs, hosted apps, and inherited browser-origin policy; disallowed browsers reconnect) |
| Gateway HTTP APIs         | `gateway.http.endpoints`, `gateway.http.securityHeaders.strictTransportSecurity`                                                                                                                                                                                   | No (next request)                                                                              |
| Gateway tools & nodes     | `gateway.tools`, `gateway.nodes.browser`, `gateway.nodes.pairing`, `gateway.nodes.commands`, `gateway.nodes.pluginTools.enabled`, `gateway.nodes.allowSkills`                                                                                                      | No                                                                                             |
| Gateway client features   | `gateway.cliAgents`, selected `gateway.controlUi` settings below                                                                                                                                                                                                   | No                                                                                             |
| Gateway push              | `gateway.push.apns.relay`                                                                                                                                                                                                                                          | No (next push)                                                                                 |
| Gateway terminal          | `gateway.terminal`                                                                                                                                                                                                                                                 | No                                                                                             |
| Desktop and Cloud Workers | `desktop.host`, `cloudWorkers`                                                                                                                                                                                                                                     | No (reconciles the owning service)                                                             |
| Gateway credentials       | `gateway.auth.token`, `gateway.auth.password`, with the same effective auth mode                                                                                                                                                                                   | No (old shared-auth clients reconnect)                                                         |
| Gateway access policy     | `gateway.roles`, `gateway.trustedProxies`, `gateway.allowRealIpFallback`, `gateway.auth.allowTailscale`, `gateway.auth.identityScopes`, `gateway.auth.trustedProxy`                                                                                                | No (clients reconnect with current authority)                                                  |
| Meeting capture           | `transcripts.enabled`, `transcripts.autoStart`                                                                                                                                                                                                                     | No (reconciles capture writers)                                                                |
| Gateway auth limits       | `gateway.auth.rateLimit`                                                                                                                                                                                                                                           | No (retains limiter state)                                                                     |
| Discovery visibility      | `discovery.mdns.mode`                                                                                                                                                                                                                                              | No (replaces discovery advertisements)                                                         |
| Browser defaults          | `browser.profiles`, `browser.defaultProfile`, `browser.headless`, `browser.executablePath`, `browser.attachOnly`, `browser.cdpUrl`, `browser.noSandbox`, `browser.extraArgs`, `browser.snapshotDefaults`, `browser.tabCleanup`, `browser.allowSystemProfileImport` | No                                                                                             |
| Browser control policy    | `browser.enabled`, `browser.evaluateEnabled`, `browser.ssrfPolicy`, `browser.extensionRelay.allowLegacyAuth`                                                                                                                                                       | No (replaces Browser control service)                                                          |
| Gateway server            | Other `gateway.*` settings (port, bind, auth mode, tailscale, TLS)                                                                                                                                                                                                 | **Yes**                                                                                        |
| Infrastructure            | Other `discovery` and `browser` settings, MCP Apps listener settings, `secrets.egressProxy`                                                                                                                                                                        | **Yes**                                                                                        |

Channel plugins declare which settings restart their channel
(`reload.configPrefixes`) and which need no reload action (`reload.noopPrefixes`).
For example, with WhatsApp loaded, `channels.whatsapp.enabled` restarts the
WhatsApp channel, while `channels.whatsapp.replyToMode` matches its broader
no-action prefix.

Changes to `channels.defaults`, `channels.modelByChannel`, `commands`,
`accessGroups`, `tts`, `surfaces`, `acp.stream`, and `diagnostics.flags` refresh
loaded channel runtimes that capture those policies. Manually stopped accounts
stay stopped, and the Gateway keeps running.

[Inbound debounce settings](/concepts/messages#inbound-debouncing) apply at the
next inbound admission without reconnecting supported channels.
`messages.ackReactionScope` applies to subsequent turns without reconnecting
Discord, Matrix, Signal, Slack, Telegram, or WhatsApp. Other channel plugins
refresh unless they declare that they read the policy live. Per-channel and
per-account overrides still take precedence; admitted turns retain their policy.

`diagnostics.enabled` updates diagnostic dispatch and heartbeat ownership live.
With `diagnostics-otel` loaded, `diagnostics.otel` restarts only its exporter service,
flushing the old generation before starting the new one. Externally preloaded
OpenTelemetry providers retain their transport and shutdown ownership.

Audit collection (`logging.audit.enabled`, `messages`, and `executionIdentity`)
applies to subsequent events and admissions. Disabling collection drains already
accepted writes; enabling it does not reconstruct earlier events or add identity
to runs already admitted without one. Existing retention policy is unchanged.

Operation settings apply at their next use; they do not restart in-flight runs
or recreate provisioned workers. Approval expiry changes affect newly issued
grants. Attachment retention changes apply on the next cleanup sweep, including
files already older than the new limit.

Update and telemetry settings apply at the next scheduled check. A pending
automatic-update countdown rechecks enablement and channel selection before
starting; an update already applying keeps its admitted target. Changing these
settings does not force an update. Telemetry consent is read again before the
next update-check request.

Internal-hook changes prepare a complete replacement before publishing it. A
load failure keeps the previous handlers; events already running finish with
their original handlers. Workspace changes reload directory hooks from the
newly selected workspace. Reload does not replay `gateway:startup`.

Under `gateway.controlUi`, the `enabled`, `environment`, `github`,
`sessionObserver`, `embedSandbox`, `allowExternalEmbedUrls`, `experimental.customPlugins`, and
`automaticallyFetchFavicons` settings hot-apply. Reload open Control UI pages to
pick up the environment label, CLI agent picker, embed preferences, and favicon
display preference; the Gateway process keeps running. `allowedOrigins` and
`dangerouslyAllowHostHeaderOriginFallback` also hot-apply: pending handshakes
recheck the new policy, and browser connections it no longer allows close.
Disabling the Control UI stops serving dashboard pages and assets and cancels
pending asset preparation. Existing Gateway connections and agent runs continue.
Re-enabling prepares missing dashboard assets in the background; requests return
`503` until they are ready. Control UI serving paths still require a Gateway restart.

Custom plugin UI changes refresh plugin views in connected Control UI pages.
Disabling it removes custom views and prevents new custom native UI loads;
reload browser tabs to clear plugin JavaScript that already ran. Bundled plugin
views and backend plugin operations remain available.

Host Desktop and Cloud Worker Desktop switches update connected desktop pickers
without a Gateway restart. Host connection changes (`managed`, `port`, and
`passwordFile`) retire existing observations and computer holds before the next
use creates the replacement source. Disabling a source closes its desktop observations.
Existing system VNC services and cloud workers remain running. Re-enabling
restores the configured host source or existing desktop-capable workers.
Cloud worker profile provisioning remains separate: `settings.desktop` affects
newly provisioned workers.

Cloud Worker profile changes apply to newly provisioned workers. Running workers
retain their admitted provisioning settings. Reserve counts and idle-suspension
policy reconcile against the current config; changing a timeout cancels an
outdated queued suspension. Repository profile defaults apply to future placement.

ACP enablement, dispatch, default agents, allowed agents, and backend policies
apply to subsequent admissions and turns. Existing runtime handles survive
unrelated config changes; backend failover retains its configured recovery
behavior. Worktree acceleration applies to the next allocation or restoration.

Meeting capture changes reconcile through the transcript owner. Added sources
start, removed or changed sources drain, and unchanged captures keep running.
Title edits apply to future captures and preserve existing transcript titles.
Disabling transcript storage stops capture writers without ending their meetings.

Role definitions, proxy trust, identity scopes, Tailscale authentication, and
trusted-proxy policies apply live. Connections and pending handshakes that retain
old policy lose authority and reconnect. Accepted policy writes can finish their
response; other work must pass the current authority checks before writing.
Changing authentication mode or listener topology still requires a Gateway restart.

Node command policy updates connected nodes immediately. Disabling node-published
tools or skills withdraws them; re-enabling restores the last publication within
the node's existing pairing approval. Reload never grants an unapproved command.
Revoking a command cancels its active invocations and rejects later input and
results. Revoking desktop streaming also closes its observer transports. Browser
node routing applies to subsequent operations. Node pairing policy
(`gateway.nodes.pairing`) also hot-applies: pending automatic approvals recheck
the current policy before granting access, including after SSH probes. Existing
paired devices remain paired. Terminal shell changes apply to newly opened
terminals; active terminals keep their original shell. Detached-session timeout
changes recalculate deadlines from each terminal's original disconnect time.
Already-expired sessions close immediately; attached terminals keep running.
Terminal enablement also hot-applies. Disabling terminals closes attached,
detached, and conversation-owned sessions and cancels pending opens. Re-enabling
allows fresh sessions; closed sessions do not return. Reload open Control UI
pages to pick up the terminal's content security policy.
An unrelated deferred restart does not delay a committed terminal enable or shell
change. A pending restart can still keep earlier terminal or sandbox restrictions
in force until that restart completes or its rejected changes are reverted.

Browser default-profile changes apply on the next request. Launch-setting
changes replace affected managed browser processes when next used; externally
attached browsers stay running. Browser enablement, evaluation, and SSRF policy
changes replace only the Browser control service: pending operations cancel and
owned Chrome processes close before the new policy applies. Attached and remote
browser processes stay open while OpenClaw disconnects its control sessions.
When enabled, Browser control starts again on demand; managed tabs from the
retired process are not kept. Changing extension relay legacy authentication replaces the owned relay generation;
externally managed relay daemons retain their own lifecycle and policy. Snapshot defaults apply to the next snapshot, and tab-cleanup settings
apply on the next sweep.

TLS certificate renewal watches the files at the running Gateway's accepted
certificate, key, and CA paths. Valid replacement material updates existing and
future HTTPS listeners, discovery, and pairing fingerprints without interrupting
connections. Incomplete or invalid replacements keep the previous material serving.
Reload mode `off` pauses renewal; re-enabling checks changes made while paused.
TLS configuration and path changes still require a Gateway restart. Remote
certificate pins remain operator-controlled; see [Gateway TLS](/gateway/config-gateway#gateway-tls).

Authentication rate-limit changes retain recorded failures, earned lockout
deadlines, and pending loopback delays. New limits and loopback exemptions apply
to subsequent attempts; tightening the attempt limit can lock a client based on
its retained failures. Removing `gateway.auth.rateLimit` restores the defaults.
Browser-origin and node-reapproval budgets remain nonexempt.

Discovery mode changes replace the current advertisements without interrupting
Gateway connections. Switching from `full` to `minimal` removes extra TXT hints
from LAN advertisements and any configured wide-area DNS-SD zone. `off` stops
LAN advertisements while configured wide-area discovery remains enabled. The
Bonjour plugin must already be enabled, and environment overrides still apply.

The Gateway accepts its configured secret whether the client sends it as a token or a password; `gateway.auth.mode` still decides which config value is the secret.

Local onboarding generates a Gateway secret by default (`gateway.auth.mode: "token"`)
without asking you to choose an auth mechanism. Existing password-mode configs
are preserved. To choose your own password explicitly, use
`openclaw onboard --gateway-password <value>` or `--gateway-auth password`.
Remote onboarding asks for one Gateway secret and stores it as `gateway.remote.token`.
See [Onboard](/cli/onboard) for storage choices and connecting without a shared secret.

Token and password rotation hot-applies only when the effective auth mode stays
the same. Existing clients using the old shared credential must reconnect with
the new credential; independently paired device-token clients remain connected.
Browser device tokens derived from the old shared credential are revoked too.
For SecretRef credentials, set `gateway.auth.mode` explicitly to make rotation
eligible for hot reload. Auth-mode changes still restart the Gateway.

<Note>
Changing `gateway.reload` or `gateway.remote` also does **not** trigger a restart.
</Note>

Canvas enablement uses plugin hot reload. Current-protocol nodes whose hosted
capabilities change reconnect to receive fresh capability URLs; other current-protocol
nodes and operator connections stay open. Legacy nodes reconnect when hosted surface
descriptors change so their protocol limits are recalculated. Pending node handshakes
also recheck those capabilities before admission.

Ordinary runtime lookups use the cached plugin inventory and do not scan plugin
files. In hybrid mode, edits under
`plugins.entries.<id>` replace the affected instance by default and rerun registration
with its new config. Unchanged plugin instances retain their registration
snapshots. A plugin's narrower reload policy can retain an instance or require a restart.

Plugin install, update, enable, disable, uninstall, and metadata refresh apply
through the running Gateway's plugin lifecycle without a Gateway restart.
Explicit plugin actions also work when passive reload is `off`. Source or
manifest edits need `openclaw plugins reload <id>`. Changing an agent workspace
alone does not refresh plugin discovery; use an explicit metadata refresh. See
[Apply changes and inspect](/plugins/manage-plugins#apply-changes-and-inspect)
and [Plugin metadata snapshots](/plugins/architecture#plugin-metadata-snapshot-and-lookup-table).

Agent requests waiting to start pause while plugin hot reload drains the old
runtime. They continue with the replacement when it is ready, or with the
previous runtime after a successful rollback. You do not need to resend these
requests. Failed restoration or Gateway shutdown still reports a failure.
If a replacement fails before activation, rollback restores the previous configured
model context limits without waiting for model discovery.

If plugin replacement times out after stopping channels, the plugin lifecycle
owner retries the admitted-work drain for up to 60 seconds before restoring the
previous code and configuration with fresh registrations. It restarts channels
after successful restoration and preserves manual stops. Unfinished writes keep
their resource ownership; they are never discarded to force a replacement.
If recovery reaches its deadline or cleanup fails, the operation ends as failed
and releases channel reload pauses. Detailed [`/ready`](/gateway/health#http-probes)
reports `plugin-reload` with the affected plugins and recovery instructions.
Retry `openclaw plugins reload <id>` once the outstanding work settles, or restart
the Gateway. See [Plugin lifecycle](/plugins/architecture#plugin-metadata-snapshot-and-lookup-table)
for cleanup and ownership details.

During channel or plugin hot reload, Gateway-hosted channel webhook routes return
`503` with `Retry-After: 1` until replacement ingress registers. Senders must honor
retry responses; this does not acknowledge delivery. Disabled or removed accounts,
manual stops, and cancelled replacement lifetimes release those temporary routes.
When replacement ingress reports ready, old paths it did not reclaim are removed.

### Reload planning

When you edit a source file that is referenced through `$include`, OpenClaw plans
the reload from the source-authored layout, not the flattened in-memory view.
That keeps hot-reload decisions (hot-apply vs restart) predictable even when a
single top-level section lives in its own included file such as
`plugins: { $include: "./plugins.json5" }`. Reload planning fails closed if the
source layout is ambiguous.
