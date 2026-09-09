---
summary: "App-server transport selection, the appServer field table, and local testing env overrides"
read_when:
  - You are choosing a Codex app-server transport
  - You need an appServer field default
  - You are overriding the app-server binary for local testing
title: "Codex app-server transport"
sidebarTitle: "App-server transport"
---

How OpenClaw starts and reaches the Codex app-server, and every `appServer` field. Part of the [Codex harness reference](/plugins/codex-harness-reference); [Where each section moved](/plugins/codex-harness-reference#where-each-section-moved) lists every section.

## App-server transport

For ordinary harness turns, OpenClaw starts the managed Codex binary shipped
with the official plugin (currently `@openai/codex` `0.153.4`):

```bash
codex app-server --listen stdio://
```

This keeps the app-server version tied to the official `codex` plugin instead of
whichever separate Codex CLI happens to be installed locally. OpenClaw resolves
`@openai/codex/bin/codex.js` from the loader-selected plugin root using Node
package resolution, including npm-hoisted and pnpm-linked dependencies. It does
not search `.bin` shims or global `PATH` for managed startup. On Windows, Node
runs the same package entrypoint without requiring a `codex.cmd` shim.
Set `appServer.command` only when you intentionally want a different executable.
Ordinary managed turns with the default isolated agent home prefer this pinned
package even when a macOS desktop bundle is installed. When
[Computer Use](/plugins/codex-computer-use) is enabled, or when `homeScope` is
`"user"` and can load native Computer Use state, managed startup instead prefers
the desktop app binary that owns the required macOS permissions. The same
desktop-first rule applies when an isolated agent home's effective Codex config
enables native Computer Use. If no desktop app bundle is installed, OpenClaw
falls back to the pinned package binary.

Before cutting over a staged OpenClaw package, run the opt-in managed-binary
check against the candidate installation:

```bash
openclaw doctor --lint --only codex/managed-app-server --json
```

The check is read-only. For every configured Codex agent it applies the same
final command selection as a live harness turn, then verifies that a selected
package-owned native binary exists and reports the plugin's exact pinned
version. A selected Codex Desktop binary, an explicit custom command, and a
remote app-server are outside this package check. The command exits nonzero on
an error-level finding, so a deployer can reject the candidate before cutover
without changing Codex state or app-server settings.

Executable handoff and native-config fencing coordinate clients inside one
running Gateway process. Restart the Gateway after another process changes the
native Codex plugin config.

Supervision resolves a separate connection. With no explicit
`appServer` connection settings, it uses managed stdio with `homeScope: "user"`;
the ordinary harness remains managed stdio with `homeScope: "agent"`. Explicit
connection settings are honored by both paths. Set `homeScope: "user"`
explicitly when the ordinary harness should share `$CODEX_HOME` (or `~/.codex`)
with native clients. A private supervised binding uses the supervision
connection regardless of the ordinary harness default. Independent App Server
processes retain separate live status and approval state.

For non-production testing against an already-running app-server, WebSocket
transport is available:

```json5
{
  plugins: {
    entries: {
      codex: {
        enabled: true,
        config: {
          appServer: {
            transport: "websocket",
            url: "ws://gateway-host:39175",
            authToken: "${CODEX_APP_SERVER_TOKEN}",
            requestTimeoutMs: 60000,
          },
        },
      },
    },
  },
}
```

Codex classifies WebSocket transport as experimental and unsupported. Prefer
managed stdio or the local Unix control socket for production workloads.

`appServer` fields:

| Field                            | Default                                                | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `transport`                      | `"stdio"`                                              | `"stdio"` spawns Codex; explicit `"unix"` connects to the local control socket; `"websocket"` connects to `url`.                                                                                                                                                                                                                                                                                                                   |
| `homeScope`                      | `"agent"`                                              | `"agent"` isolates ordinary harness state per OpenClaw agent. `"user"` is an explicit opt-in that shares the native `$CODEX_HOME` or `~/.codex`, uses native auth, and enables owner-only thread management. User scope supports local stdio or Unix transport. For the separate supervision connection, an unset value resolves to `"user"` for stdio or Unix and `"agent"` for WebSocket.                                        |
| `command`                        | managed Codex binary                                   | Executable for stdio transport. Leave unset to use the managed binary.                                                                                                                                                                                                                                                                                                                                                             |
| `args`                           | `["app-server", "--listen", "stdio://"]`               | Arguments for stdio transport.                                                                                                                                                                                                                                                                                                                                                                                                     |
| `url`                            | unset                                                  | WebSocket App Server URL or `unix://` URL. An empty explicit Unix path selects the canonical user-home control socket.                                                                                                                                                                                                                                                                                                             |
| `authToken`                      | unset                                                  | Bearer token for WebSocket transport. Accepts a literal string or SecretInput such as `${CODEX_APP_SERVER_TOKEN}`.                                                                                                                                                                                                                                                                                                                 |
| `headers`                        | `{}`                                                   | Extra WebSocket headers. Header values accept literal strings or SecretInput values, for example `x-codex-client-session-token: "${CODEX_CLIENT_SESSION_TOKEN}"`.                                                                                                                                                                                                                                                                  |
| `clearEnv`                       | `[]`                                                   | Extra environment variable names removed from the spawned stdio app-server process after OpenClaw builds its inherited environment.                                                                                                                                                                                                                                                                                                |
| `remoteWorkspaceRoot`            | unset                                                  | Remote Codex app-server workspace root. OpenClaw maps the local cwd into this root and transfers authoritative remote attachments over an output-capped, no-shell `command/exec` reader. Paths escaping either workspace, symbolic links, oversized files, and unbounded attachment batches fail closed; uploads retain the configured channel identity and app-server request timeout.                                            |
| `loopDetectionPreToolUseRelay`   | `true`                                                 | Enables the Codex `PreToolUse` relay for loop detection when OpenClaw loop detection is enabled. OpenClaw installs no `PreToolUse` relay when no before-tool plugin hook, trusted-tool policy, or enabled loop detector has local work. Set `false` to disable the loop-detection relay even when detection is enabled; before-tool plugin hooks and trusted-tool policy still install their required fail-closed relay.           |
| `requestTimeoutMs`               | `60000`                                                | Timeout for app-server control-plane calls.                                                                                                                                                                                                                                                                                                                                                                                        |
| `mode`                           | `"yolo"` unless local Codex requirements disallow YOLO | Preset for YOLO or guardian-reviewed execution.                                                                                                                                                                                                                                                                                                                                                                                    |
| `approvalPolicy`                 | `"never"` or an allowed guardian approval policy       | Native Codex approval policy sent to thread start, resume, and turn.                                                                                                                                                                                                                                                                                                                                                               |
| `sandbox`                        | `"danger-full-access"` or an allowed guardian sandbox  | Native Codex sandbox mode sent to thread start and resume. Active OpenClaw sandboxes narrow `danger-full-access` turns to Codex `workspace-write`; the turn network flag follows OpenClaw sandbox egress.                                                                                                                                                                                                                          |
| `approvalsReviewer`              | `"user"` or an allowed guardian reviewer               | Use `"auto_review"` to let Codex review native approval prompts when allowed.                                                                                                                                                                                                                                                                                                                                                      |
| `defaultWorkspaceDir`            | current process directory                              | Workspace used by `/codex bind` when `--cwd` is omitted.                                                                                                                                                                                                                                                                                                                                                                           |
| `serviceTier`                    | unset                                                  | Native Codex app-server preference only. Any non-empty string passes through for forward compatibility; documented values are `"priority"` and `"flex"`. `null` clears the override, and legacy `"fast"` normalizes to `"priority"`. This is neither the shared Fast-mode setting nor a direct embedded OpenAI setting. A shared Fast run control supersedes it with `priority` or `null`, or decides per model call in auto mode. |
| `networkProxy`                   | disabled                                               | Opt into Codex permissions-profile networking for app-server commands. OpenClaw defines the selected `permissions.<profile>.network` config and selects it with `default_permissions` instead of sending `sandbox`.                                                                                                                                                                                                                |
| `experimental.sandboxExecServer` | `false`                                                | Preview opt-in that registers an OpenClaw sandbox-backed Codex environment with the supported Codex app-server so native Codex execution can run inside the active OpenClaw sandbox.                                                                                                                                                                                                                                               |

`appServer.args` accepts an array (recommended) or a quoted argument string.
`OPENCLAW_CODEX_APP_SERVER_ARGS` uses the same string parsing on every platform:
single and double quotes group words, backslashes and `#` stay literal, and an
unfinished quote groups the remaining text. This preserves the string grammar
shipped in `v2026.9.1`; strings do not use shell escaping.

Use array entries for values containing embedded quotes, such as
`'model="gpt-5.6-luna"'`. For a directory containing a literal backslash, both
forms below pass the same path to Codex:

```json5 validate=false
args: "app-server --listen stdio:// -c log_dir=/tmp/openclaw\\logs"
```

```json5 validate=false
args: ["app-server", "--listen", "stdio://", "-c", "log_dir=/tmp/openclaw\\logs"]
```

The `\\` in JSON5 encodes one backslash. Array entries preserve embedded quotes
and backslashes, but surrounding whitespace is trimmed and empty entries are
omitted. Strings also omit empty quoted arguments. Account for these limits
before converting existing strings to arrays.

`appServer.serviceTier` is used only when no shared Fast-mode run control is
supplied. On Codex harness turns, shared Fast on sends `priority`, Fast off
sends `null` to clear the OpenClaw-owned tier, and auto decides for each model
call. `/codex fast off` is separate: it persists `flex` in the bound native
conversation preference for later conversation-bound turns and does not change
the shared OpenClaw session policy. These values describe native configuration
and preference state, not observed provider routing.

`appServer.networkProxy` is explicit because it changes the Codex sandbox
contract. When enabled, OpenClaw also sets `features.network_proxy.enabled` and
`default_permissions` in the Codex thread config so the generated permission
profile can start Codex-managed networking. OpenClaw generates a
collision-resistant `openclaw-network-<fingerprint>` profile name from the
profile body by default; use `profileName` only when a stable local name is
required.

```js
export default {
  plugins: {
    entries: {
      codex: {
        config: {
          appServer: {
            sandbox: "workspace-write",
            networkProxy: {
              enabled: true,
              domains: {
                "api.openai.com": "allow",
                "blocked.example.com": "deny",
              },
              allowUpstreamProxy: true,
              proxyUrl: "http://127.0.0.1:3128",
            },
          },
        },
      },
    },
  },
};
```

If the normal app-server runtime would be `danger-full-access`, enabling
`networkProxy` uses workspace-style filesystem access for the generated
permission profile instead. Codex-managed network enforcement is sandboxed
networking, so a full-access profile would not protect outbound traffic.

The plugin manages stable Codex app-server `0.153.4`. Explicit custom
executables, remote app-servers, and macOS desktop binaries must report a
parseable semantic version of `0.149.0` or newer. Older, malformed, and
unversioned handshakes are rejected. Newer versions log a compatibility warning
and continue through normal runtime and capability validation.

OpenClaw treats non-loopback WebSocket app-server URLs as remote and requires
identity-bearing WebSocket auth through `appServer.authToken` or an
`Authorization` header. `appServer.authToken` and each `appServer.headers.*`
value can be a SecretInput; the secrets runtime resolves SecretRefs and env
shorthand before OpenClaw builds app-server start options, and unresolved
structured SecretRefs fail before any token or header is sent.

When native Codex plugins are configured, OpenClaw caches one
runtime-and-workspace-scoped `plugin/installed` snapshot. This snapshot covers
installed plugins from Codex-discovered marketplaces, including disabled ownership;
`plugin/read` resolves only exact configured plugin identities. Failed or
incomplete installed snapshots are never cached. `/codex plugins available`
queries `plugin/list` for the current conversation workspace, while
`/codex plugins install <plugin>@<marketplace>` installs only after an owner or
`operator.admin` explicitly authorizes that plugin. Existing explicitly
configured curated plugins retain their automatic recovery path. The model's
plugin-discovery tool cannot install, enable, or authenticate a plugin.

`app/installed` reports installed app runtime state, and `app/read` returns
authenticated metadata for at most 100 requested app IDs per call. OpenClaw
force-refreshes the first cold installed snapshot and consolidates successful
curated installations into one app-inventory refresh. Later cached reads do
not force repeated connector refreshes.

Deny-by-default Codex app policy is evaluated per thread, so an explicitly
allowed app can be installed and authenticated before it becomes callable.
OpenClaw provisionally admits only ownership-proven, policy-approved apps,
creates the thread with `_default.enabled = false` and explicit app overrides,
then calls `app/installed` once with that thread's ID and `forceRefresh: false`.
If that snapshot reports missing, disabled, or non-callable apps, OpenClaw logs
one warning and continues with the remaining tools. Codex still enforces
managed restrictions, workspace policy, and app/tool permissions; unavailable
apps gain no access.

The check completes before OpenClaw injects history, starts a turn, or
persists the native thread binding. If the snapshot request fails, OpenClaw deletes a persistent
provisional thread with `thread/delete` or unsubscribes an ephemeral thread
with `thread/unsubscribe`. If safe cleanup cannot be confirmed, it retires the
owning app-server connection. Supervised branches also clean up their temporary
probe and retain recovery state when cleanup fails.

With `allow_all_plugins`, an explicitly disabled configured workspace plugin
still denies its owned apps. When `app/read` does not expose that ownership,
OpenClaw uses its `plugin/installed` snapshot and reads only the exact
configured plugin's details to reserve the denied app IDs. It does not scan
unrelated marketplaces or install, enable, or authenticate the disabled plugin;
missing ownership fails closed.

Only connect OpenClaw to a `0.149.0` or newer remote app-server trusted to accept
configured marketplace plugin installs and inventory refreshes. Missing modern
inventory methods and server, authentication, or transport failures fail closed.

## Environment overrides

Environment overrides remain available for local testing:

- `OPENCLAW_CODEX_APP_SERVER_BIN`
- `OPENCLAW_CODEX_APP_SERVER_ARGS`
- `OPENCLAW_CODEX_APP_SERVER_MODE=yolo|guardian`
- `OPENCLAW_CODEX_APP_SERVER_APPROVAL_POLICY`
- `OPENCLAW_CODEX_APP_SERVER_SANDBOX`

`OPENCLAW_CODEX_APP_SERVER_BIN` bypasses the managed binary when
`appServer.command` is unset.

`OPENCLAW_CODEX_APP_SERVER_GUARDIAN=1` was removed. Use
`plugins.entries.codex.config.appServer.mode: "guardian"` instead, or
`OPENCLAW_CODEX_APP_SERVER_MODE=guardian` for one-off local testing. Config is
preferred for repeatable deployments because it keeps the plugin behavior in
the same reviewed file as the rest of the Codex harness setup.
