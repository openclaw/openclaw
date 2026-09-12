---
summary: "Session target resolution and the full /acp command and runtime option reference"
title: "ACP agents controls"
read_when:
  - Operating /acp commands from chat
  - You need the /acp command reference
  - You need the runtime option mapping for a backend
---

## Session target resolution

Most `/acp` actions accept an optional session target (`session-key`,
`session-id`, or `session-label`).

**Resolution order:**

1. Explicit target argument (or `--session` for `/acp steer`)
   - tries key
   - then UUID-shaped session id
   - then label
2. Current thread binding (if this conversation/thread is bound to an ACP session).
3. Current requester session fallback.

Current-conversation bindings and thread bindings both participate in step 2.

If no target resolves, OpenClaw returns a clear error
(`Unable to resolve session target: ...`).

### Session owner and harness

The OpenClaw agent that owns a session is separate from the external harness
selected by ACP. For example, a session owned by `work` can run the `claude`
harness. Owner-aware manager calls carry `agentId`; `agent` remains the harness
name. Configured bindings use their OpenClaw agent owner and their configured
ACP harness independently. Free ACP spawns keep their existing harness namespace.

Bare keys such as `global` require an explicit owner when ownership is explicit.
ACP keeps arbitrary logical keys such as `shared-project` unchanged; ACPX scopes
the backend resource name by owner.
An agent-qualified main alias retains its owner even when it resolves to `global`.
Conflicting owner/key pairs fail visibly. A backend that cannot isolate bare
sessions must be upgraded before those sessions can run.

## ACP controls

| Command              | What it does                                              | Example                                                       |
| -------------------- | --------------------------------------------------------- | ------------------------------------------------------------- |
| `/acp spawn`         | Create ACP session; optional current bind or thread bind. | `/acp spawn codex --bind here --cwd /repo`                    |
| `/acp cancel`        | Cancel in-flight turn for target session.                 | `/acp cancel agent:codex:acp:<uuid>`                          |
| `/acp steer`         | Send steer instruction to running session.                | `/acp steer --session support inbox prioritize failing tests` |
| `/acp close`         | Close session and unbind thread targets.                  | `/acp close`                                                  |
| `/acp status`        | Show backend, mode, state, runtime options, capabilities. | `/acp status`                                                 |
| `/acp set-mode`      | Set runtime mode for target session.                      | `/acp set-mode plan`                                          |
| `/acp set`           | Generic runtime config option write.                      | `/acp set model openai/gpt-5.4`                               |
| `/acp cwd`           | Set runtime working directory override.                   | `/acp cwd /Users/user/Projects/repo`                          |
| `/acp permissions`   | Set approval policy profile.                              | `/acp permissions strict`                                     |
| `/acp timeout`       | Set runtime timeout (seconds).                            | `/acp timeout 120`                                            |
| `/acp model`         | Set runtime model override.                               | `/acp model anthropic/claude-opus-4-6`                        |
| `/acp reset-options` | Remove session runtime option overrides.                  | `/acp reset-options`                                          |
| `/acp sessions`      | List recent ACP sessions from store.                      | `/acp sessions`                                               |
| `/acp doctor`        | Backend health, capabilities, actionable fixes.           | `/acp doctor`                                                 |
| `/acp install`       | Print deterministic install and enable steps.             | `/acp install`                                                |

Runtime controls (`spawn`, `cancel`, `steer`, `close`, `status`, `set-mode`,
`set`, `cwd`, `permissions`, `timeout`, `model`, and `reset-options`) require
owner identity from external channels and `operator.admin` from internal
Gateway clients. Authorized non-owner senders can still use `sessions`,
`doctor`, `install`, and `help`. For non-owner senders, `/acp sessions`
lists only the current bound or requester session; owner identity and
`operator.admin` clients see all recent sessions.

`/acp status` shows the effective runtime options plus runtime-level and
backend-level session identifiers. Unsupported-control errors surface
clearly when a backend lacks a capability. Commands that accept target tokens
(`session-key`, `session-id`, or `session-label`) resolve them through gateway
session discovery, including custom per-agent `session.store` roots. `/acp sessions`
does not accept a target token.

### Runtime options mapping

`/acp` has convenience commands and a generic setter. Equivalent operations:

| Command                      | Maps to                              | Notes                                                                                                                                                                                                      |
| ---------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/acp model <id>`            | runtime config key `model`           | For Codex ACP, OpenClaw normalizes `openai/<model>` to the adapter model id and maps slash reasoning suffixes such as `openai/gpt-5.4/high` to `reasoning_effort`.                                         |
| `/acp set thinking <level>`  | canonical option `thinking`          | OpenClaw sends the backend-advertised equivalent when present, preferring `thinking`, then `effort`, `reasoning_effort`, or `thought_level`. For Codex ACP, the adapter maps values to `reasoning_effort`. |
| `/acp permissions <profile>` | canonical option `permissionProfile` | OpenClaw sends the backend-advertised equivalent when present, such as `approval_policy`, `permission_profile`, `permissions`, or `permission_mode`.                                                       |
| `/acp timeout <seconds>`     | canonical option `timeoutSeconds`    | OpenClaw sends the backend-advertised equivalent when present, such as `timeout` or `timeout_seconds`.                                                                                                     |
| `/acp cwd <path>`            | runtime cwd override                 | Applied on the next runtime operation, which closes the previous handle before replacing it.                                                                                                               |
| `/acp set <key> <value>`     | generic                              | `key=cwd` uses the cwd override path.                                                                                                                                                                      |
| `/acp reset-options`         | clears all runtime overrides         | Closes a retained runtime without starting a new backend.                                                                                                                                                  |

When a backend returns its accepted controls, OpenClaw keeps an already-selected
thinking level in sync with that response. A model switch may lower the level or
remove thinking support; subsequent turns and reconnects use the accepted
selection instead of replaying the old level. Backend defaults do not become new
session overrides, and the model reference keeps its OpenClaw provider prefix.
Model overrides are validated before prompt submission, including after reconnect.
Unsupported inherited defaults dropped during new session initialization are not
saved as overrides.

`/acp reset-options` also works after a restart when an old working directory or
model override prevents backend startup. If closing a retained runtime fails,
the options remain available for retry.
