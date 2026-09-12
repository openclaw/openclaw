---
summary: "Native Codex session discovery and agent-facing supervision settings"
read_when:
  - You are enabling or disabling native Codex session discovery
  - You need the supervision config fields and endpoint fields
  - You are registering additional local Codex homes
title: "Codex session catalog and supervision"
sidebarTitle: "Supervision"
---

Native session discovery for the sidebar and the agent-facing supervision policy. Part of the [Codex harness reference](/plugins/codex-harness-reference); [Where each section moved](/plugins/codex-harness-reference#where-each-section-moved) lists every section.

## Supervision

Native session discovery lists non-archived Codex sessions from the Gateway
computer and opted-in paired nodes by default. Disable only that catalog with:

```json5
{
  plugins: {
    entries: {
      codex: {
        enabled: true,
        config: {
          sessionCatalog: {
            enabled: false,
          },
        },
      },
    },
  },
}
```

Discovery automatically covers the Gateway process Codex home (`CODEX_HOME` or
`~/.codex`) and the Codex home of every configured OpenClaw agent. Register
additional local Codex stores only when sessions live in a home OpenClaw does
not already know about, for example a store created with a custom `CODEX_HOME`
outside OpenClaw:

```json5
{
  plugins: {
    entries: {
      codex: {
        enabled: true,
        config: {
          sessionCatalog: {
            homes: [
              "/path/to/additional-codex-home",
              { path: "/path/to/review-codex-home", label: "Review sessions" },
            ],
          },
        },
      },
    },
  },
}
```

Configured stores appear in the sidebar alongside automatically discovered
ones, labeled `Local Codex · <label>` and grouped by each session's working
directory. String entries and objects without `label` use the basename of the
canonicalized home directory; an explicit `label` overrides that default.
Sessions in these stores support the same view, continue, and archive actions,
and the selected OpenClaw agent still owns the resulting connection; `homes`
only adds catalog sources.

Fresh native terminal sessions use the primary local profile, shown as
`Local Codex`, or an eligible paired node. Additional local homes are session
discovery and resume sources, not separate fresh-start destinations. The selected
working directory controls Codex's project configuration without changing its home
or login. See [Native CLI starts](/web/control-ui/sessions-and-sidebar#start-a-native-coding-cli).

Only existing directories are included. Equivalent paths are canonicalized and
deduplicated against the automatic homes, and automatic homes keep priority
under the 100-source catalog cap. Changes require a Gateway restart.
`sessionCatalog.homes` needs the default managed stdio app-server transport;
Unix and WebSocket transports reject it with a visible error because they
cannot start a source-bound app-server for each home.

`supervision` separately controls agent-facing tools:

| Field                 | Default                 | Meaning                                                                                                                                                                                                                                   |
| --------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`             | `false`                 | Enable agent-facing Codex supervision tools. This does not control the authenticated operator session catalog.                                                                                                                            |
| `endpoints`           | built-in local endpoint | Compatibility and advanced endpoint targets for the retained Codex supervision agent and standalone MCP tools. The human catalog and branch flow ignore these targets and use the supervision App Server resolved from `appServer`.       |
| `allowRawTranscripts` | `false`                 | With supervision enabled, allow autonomous agent or standalone MCP transcript reads and transcript-derived list fields. `codex_threads` metadata-only reads remain available. Does not control authenticated Control UI continuation.     |
| `allowWriteControls`  | `false`                 | With supervision enabled, allow autonomous `codex_threads` fork, rename, archive, and unarchive mutations plus standalone MCP send, steer, and interrupt operations. Does not bypass other binding, host, status, or confirmation checks. |

Endpoint entries accept these fields:

| Field          | Applies to    | Meaning                                                               |
| -------------- | ------------- | --------------------------------------------------------------------- |
| `id`           | all           | Stable endpoint id.                                                   |
| `label`        | all           | Optional display label.                                               |
| `transport`    | all           | `"stdio-proxy"` or `"websocket"`.                                     |
| `command`      | `stdio-proxy` | Optional App Server command.                                          |
| `args`         | `stdio-proxy` | Optional command arguments.                                           |
| `cwd`          | `stdio-proxy` | Optional child-process working directory.                             |
| `url`          | `websocket`   | Required WebSocket or supported local socket URL.                     |
| `authTokenEnv` | `websocket`   | Optional environment variable whose value authenticates the endpoint. |

The **Codex Sessions** page uses the plugin's supervision App Server and shows
only non-archived sessions. Without explicit `appServer` connection settings,
that connection is managed user-home stdio. Stored or idle local rows can create
a model-locked Chat with bounded user and assistant history through the last
terminal persisted source turn. Its private binding keeps the snapshot fork,
canonical `appServer`-source branch, history injection, and later turns on that
connection. The first canonical start uses the pair returned by the fork. Later
resumes omit OpenClaw model and provider overrides so Codex restores the
canonical thread's persisted pair; a separate native change can update that
pair, but the outer model and fallback chain never replace it. Stored and idle
rows can be archived after no-other-runner confirmation, unless another active
OpenClaw binding owns the exact target or one of its non-archived spawned
descendants. OpenClaw follows Codex's descendant pagination and fails closed on
enumeration errors, cycles, or safety-limit exhaustion. Confirmation still
covers unknown native clients and the status-to-archive race. A supervised
model-locked Chat cannot be deleted while it protects the native binding.
Active sources cannot create a branch or be archived, but an existing supervised
Chat can still be opened. Paired-node continuation requires `operator.admin`, a
stored or idle interactive thread, and a connected node advertising and
permitting the catalog list, transcript read, and `codex.cli.session.resume`
commands. It binds Chat to native CLI resume on that node, not the local branch
flow or a streaming App Server harness. Other paired-node rows remain readable,
and paired-node archive is unavailable. See
[paired-node limits](/plugins/codex-supervision#understand-paired-node-limits).

`appServer.homeScope: "user"` alone changes which Codex home a managed harness
process uses; it does not publish the fleet catalog. Enabling supervision does
not change the harness default. Instead, the separate supervision connection
defaults to managed user-home stdio when no explicit `appServer`
connection settings exist. Explicit settings are honored for that connection.
Pending and committed supervised bindings retain that connection for every turn;
disabled supervision or connection/lifecycle drift fails closed instead of
falling back to the agent-home harness. The default connection shares stored
sessions with native Codex clients, not their process-local activity state.

Legacy `plugins.entries.codex-supervisor` settings are retired. Run
`openclaw doctor --fix` to migrate the old entry, endpoint definitions, policy
flags, and plugin allow/deny references into this block. Explicit canonical
`codex.config.supervision` values win conflicts.
