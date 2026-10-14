---
summary: "Run OpenClaw embedded agent turns for Meta models through the Muse Code CLI"
title: "Muse Code agent runtime"
read_when:
  - You want an agent to run Meta Muse Spark models through the Muse Code CLI
  - You need configuration examples for the `muse` runtime
  - You are deciding between the built-in OpenClaw runtime and Muse Code for `meta/*` models
---

The external `@openclaw/muse` plugin runs embedded agent turns for `meta/*`
models through [Muse Code](https://dev.meta.ai/docs/muse-code), Meta's coding
agent CLI. The plugin starts `muse serve` and talks to it over the Muse Session
Protocol (MSP) with the official `@muse-code/sdk` client.

Muse Code owns the low-level agent loop: native shell, file read/write/edit
tools, its OS sandbox, and its session state. OpenClaw still owns chat
channels, model selection, approvals, the visible chat transcript, and the
mapping from OpenClaw sessions to Muse sessions.

For the broader model/provider/runtime split, start with
[Agent runtimes](/concepts/agent-runtimes).

## Requirements

- OpenClaw. Model Setup can install and enable the `@openclaw/muse` plugin.
- If your config uses `plugins.allow`, allow `muse` (the manifest id), not the
  npm package name.
- The Muse Code CLI installed separately, with a `muse` binary on `PATH` or a
  configured `binaryPath`. Install it with Meta's installer:

  ```bash
  curl -fsSL https://dev.meta.ai/install.sh | bash
  muse --version
  ```

- A Meta credential: a Muse Code browser sign-in, a stored key, or a `meta`
  auth profile in OpenClaw (see [Auth](#auth)).

## Install

Model Setup installs the plugin when you choose **Muse Code**. To install it
manually instead:

```bash
openclaw plugins install @openclaw/muse
```

The plugin does not install or update the `muse` binary. It sets
`MUSE_NO_AUTO_UPDATE=1` on the processes it starts, so Muse does not update
itself in the middle of a Gateway run. Update Muse with its own installer.

## Quickstart

1. Open **Model Setup** (`/models`) in the Control UI.
2. In **AI Setup**, choose **Connect provider**, then **Meta → Muse Code**.
3. Start sign-in, confirm the displayed device code in the browser, and approve it.

OpenClaw enables the Muse plugin and selects `meta/muse-spark-1.3` with the
`muse` runtime by default. If you choose another Meta model during setup,
that model uses Muse instead. No terminal login or manual runtime configuration
is needed.

The **Provider Access** connection dialog manages credentials without changing
the active model. Use the **AI Setup** connection dialog for Muse Code because
its sign-in also installs the runtime and selects a model.

For manual configuration, route one Meta model through the Muse runtime:

```json5
{
  agents: {
    defaults: {
      model: "meta/muse-spark-1.3",
      models: {
        "meta/muse-spark-1.3": {
          agentRuntime: { id: "muse" },
        },
      },
    },
  },
}
```

Set `agentRuntime.id` on one model entry to route only that model, or on the
`meta` provider to route every Meta model. Models without this routing use the
built-in OpenClaw runtime through the [Meta provider](/providers/meta).

Choosing **Muse Code** in Model Setup routes the selected model through Muse
for the agent being set up. It writes that agent's model entry, replacing any
runtime choice already on it. Global model defaults, other agents and other
Meta models keep their existing runtime policy.

The harness accepts only the standard `meta` provider route on Meta's official
endpoint (`https://api.meta.ai/v1`). A `meta` provider entry with another
`baseUrl` or with request transport overrides is refused, because Muse Code
calls Meta itself.

## Auth

Use **Model Setup → Muse Code** in the Control UI for browser sign-in.
The credential stays in Muse Code's own credential store; OpenClaw does not
copy it into an auth profile. This sign-in authorizes the Muse runtime, not
the direct Meta API route.

For Muse-owned sign-ins, setup checks that Muse can fetch the selected model
from Meta's live catalog. It does not run a model turn or expose native tools
during verification. The same check runs again before activation is committed.

Gateway-driven sign-in always uses Muse's file credential backend under the
OpenClaw state directory (`muse/muse/auth.json`). It needs one browser approval
and does not access the macOS Keychain. Verification and chat use that same
credential directory when its credential file exists.

Alternatively, run `muse login` on the Gateway host and approve the browser
code, or store an API key with `muse auth set`. When no Gateway-managed credential
file exists, the harness uses Muse's own default credential store, including its
native Keychain support, without an OpenClaw auth profile.

The harness picks one credential per attempt, in this order:

1. The API key OpenClaw resolved for the attempt's selected `meta` auth profile.
2. The API key from the exact selected `meta:` auth profile, resolved through
   the provider auth runtime.
3. `META_API_KEY` in the Gateway environment, followed by the Gateway-managed
   Muse credential file when present; otherwise Muse's own default credential store.

When OpenClaw selects a key, the harness gives it to Muse as `META_API_KEY`.
The Meta provider's `MODEL_API_KEY` is not passed to Muse; Muse does not read
it.

Each credential gets its own `muse serve` process. Changing the key starts a
new Muse session instead of resuming one that belongs to another credential.
Switching between native and Gateway-managed credentials, or changing the
managed credential file, retires the pooled process and starts a fresh session.

If Muse rejects the credential, or finds none, the turn fails. Chat shows
OpenClaw's generic failure notice; the Gateway log (`openclaw logs --follow`)
carries the actionable cause, for example "Muse Code is not signed in on the
Gateway host ... Run `muse login` there, or set META_API_KEY for the Gateway",
plus the last lines of Muse's stderr (an invalid `META_API_KEY` appears only
there).

## Configuration

| Key          | Default | Purpose                                                     |
| ------------ | ------- | ----------------------------------------------------------- |
| `binaryPath` | `muse`  | Muse executable path, or a command name resolved on `PATH`. |

```json5
{
  plugins: {
    entries: {
      muse: {
        enabled: true,
        config: { binaryPath: "/opt/homebrew/bin/muse" },
      },
    },
  },
}
```

Model choice comes from the OpenClaw model ref. The thinking level maps to
Muse's reasoning effort: `off` becomes `minimal` (Muse Spark does not accept
`none`), and `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, and `ultra`
pass through. `adaptive` is refused because Muse has no adaptive mode.

Prepared image attachments are forwarded to Muse as native MSP image input,
including their media type and base64 payload.

## Approvals and sandbox

The harness resolves `tools.exec.mode`, legacy `security`/`ask` settings,
agent-specific settings, and per-session exec overrides in that order.
Explicit modes replace legacy fields in the same layer. Host-local exec approval
defaults and agent-specific approval settings then apply as stricter security
and ask floors; `tools.exec.mode: "full"` does not bypass them. Only an explicit
full-session elevation can bypass those floors while its effective security
remains full. The effective policy maps to Muse's approval mode and sandbox posture:

| OpenClaw exec policy                 | Muse behavior                                                                                 |
| ------------------------------------ | --------------------------------------------------------------------------------------------- |
| `security: "deny"`                   | `muse serve --disable-shell --disable-write`, approval mode `denyUnmatched`.                  |
| `security: "full"` with `ask: "off"` | Approval mode `allowAll`.                                                                     |
| Default and other combinations       | Approval mode `promptUnmatched`: Muse applies its own rules and asks OpenClaw about the rest. |
| `security: "allowlist"`              | Refused. Muse cannot enforce OpenClaw's exec allowlist.                                       |
| `ask: "always"`                      | Refused. Muse cannot guarantee an approval prompt for every native command.                   |

When Muse asks for approval, OpenClaw shows its normal approval prompt with
**Allow once** and **Deny** to approval surfaces watching the session, such as
the Control UI. The harness answers with a choice that Muse offered. A denied,
expired, or cancelled approval sends a deny choice, and so does an approval
with no surface to show it. Each approval waits up to two minutes. The harness
never grants persistent approvals.

The harness also refuses an attempt when OpenClaw requires an OpenClaw sandbox,
workspace-only file access, or a restricted plugin tool policy. Muse runs on
the Gateway host and cannot enforce those boundaries. Select the `openclaw`
runtime for those agents or sessions.

A refused attempt fails before any `muse` process starts, with an error that
names the setting.

## Sessions

The plugin stores one binding per OpenClaw session in its plugin state: the
Muse session id plus a fingerprint of the workspace, model, credential,
read-only posture, and approval mode. The binding is saved only after Muse
accepts the turn. The next turn resumes that Muse session when the fingerprint
matches. If any of those inputs changed, or the previous transcript was marked
unsafe to replay, the next turn starts a new Muse session. Changes to Muse's own
MCP configuration do not start a new session.

If Muse refuses to resume the stored session, the harness starts a new Muse
session and logs why. Muse runs nothing when it refuses a resume, and the
OpenClaw transcript keeps the conversation. This covers a session that no
longer exists and a retained session Muse can no longer open (for example, one
created with a permission profile that needs the subscription's automated
reviewer after `muse logout`). Transport failures, and sessions Muse reports as
in use or overloaded, fail the turn instead, so a turn that may still be
running is never repeated.

Every fresh Muse session receives the retained OpenClaw conversation branch
before the current prompt, including after a model change, a refused resume, or
a committed history reset. This transfer is bounded by OpenClaw's model-context
reader. If the retained context cannot be read safely within that bound, the
turn fails instead of silently starting without its history; compact the
session or switch to the `openclaw` runtime.

Fresh sessions also receive OpenClaw workspace bootstrap context, such as
`SOUL.md`, `USER.md`, and `MEMORY.md`, with the normal session, channel, and
bootstrap-mode filters. MSP has no system-message or history-import field, so
the harness prefixes this context to the first native user input. Resumed
sessions do not repeat that prefix.

`/new` and `/reset` stop an active Muse turn and delete the binding.
Rewinding or switching branches within the same OpenClaw session also
invalidates the binding, but only after the history change commits.

Stopping a turn waits for Muse's terminal event, not just its interrupt
acknowledgement. If Muse does not settle within five seconds, the harness
closes the host before releasing the attempt.

`muse serve` processes are pooled per workspace, credential, and read-only
posture, and shut down after five idle minutes.

## Transcript

Each completed Muse item (assistant text, reasoning, tool calls, and tool
results) is written to the OpenClaw session transcript as soon as Muse
finishes it, keyed by the Muse session and item id so a retried write cannot
duplicate entries. A transcript write failure stops the turn.

## MCP servers

Muse owns its MCP configuration. Add MCP servers in Muse itself; OpenClaw's
`mcp.servers` are not passed to Muse sessions.

## Limitations

- OpenClaw's own agent tools (messaging, `sessions_spawn`, browser, and other
  OpenClaw tools) are not available to Muse. MSP has no client-tool contract.
  Muse uses its native tools and its own MCP servers. Replies go back to the
  channel from the final turn text.
- No live steering: a message sent during an active turn waits for the turn to
  finish.
- No native compaction, isolated completions, or `/btw` side questions through
  Muse. `/btw` uses the configured model provider directly, as on other
  non-Codex runtimes.
- No `ask_user`-style questions from Muse.
- MSP has no system-instruction field. OpenClaw's extra system prompt is
  prepended to the user message of each turn.
- Muse runs on the Gateway host only. It is not available with OpenClaw
  sandboxes or remote node execution.
- Muse's built-in `echo` provider is not available over `muse serve`, so the
  runtime always needs a working Meta credential.
- Model Setup checks a new Meta API-key sign-in with a short tool-restricted probe
  turn. Muse cannot enforce that restriction, so while `meta/*` models are
  routed to `muse`, activating a new `meta` API key in Model Setup fails with
  "Muse Code cannot enforce this conversation's tool policy". Use Muse's own
  sign-in instead (see [Auth](#auth)).

## Live tests

```bash
# Real `muse` binary, no credentials: handshake, start/resume, auth error, interrupt, exit
OPENCLAW_MUSE_LIVE_HOST=1 node scripts/run-vitest.mjs \
  --config test/vitest/vitest.live.config.ts extensions/muse/src/runtime.live.test.ts

# Docker, offline after setup: fake MSP host behind a real Gateway
pnpm test:docker:muse-runtime

# Docker, real Muse: approve the printed MUSE_DEVICE_CODE in the browser,
# or pass OPENCLAW_MUSE_LIVE_KEY=<key> instead of device auth
OPENCLAW_MUSE_LIVE_AUTH=device pnpm test:docker:live-muse
```

The Docker lanes use disposable Gateways; credentials live only in the
container. The live lane is opt-in and checks a real reply, recall after a
Gateway restart, an allow-once shell approval, and the sign-in error after
`muse logout`.

## Related

- [Meta provider](/providers/meta)
- [Agent runtimes](/concepts/agent-runtimes)
- [Agent harness plugins](/plugins/sdk-agent-harness)
