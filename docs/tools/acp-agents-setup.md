---
summary: "Setting up ACP agents: acpx harness config, plugin setup, permissions"
read_when:
  - Installing or configuring the acpx harness for Claude Code / Codex / Gemini CLI
  - Enabling the plugin-tools or OpenClaw-tools MCP bridge
  - Configuring ACP permission modes
title: "ACP agents — setup"
---

For the overview, operator runbook, and concepts, see [ACP agents](/tools/acp-agents).

The sections below cover acpx harness config, plugin setup for the MCP bridges, and permission configuration.

Use this page only when you are setting up the ACP/acpx route. For native Codex
app-server runtime config, use [Codex harness](/plugins/codex-harness). For
OpenAI API keys or Codex OAuth model-provider config, use
[OpenAI](/providers/openai).

Codex has two OpenClaw routes:

| Route                      | Config/command                                         | Setup page                              |
| -------------------------- | ------------------------------------------------------ | --------------------------------------- |
| Native Codex app-server    | `/codex ...`, `agentRuntime.id: "codex"`               | [Codex harness](/plugins/codex-harness) |
| Explicit Codex ACP adapter | `/acp spawn codex`, `runtime: "acp", agentId: "codex"` | This page                               |

Prefer the native route unless you explicitly need ACP/acpx behavior.

## acpx harness support (current)

Current acpx built-in harness aliases:

- `claude`
- `codex`
- `copilot`
- `cursor` (Cursor CLI: `cursor-agent acp`)
- `droid`
- `gemini`
- `iflow`
- `kilocode`
- `kimi`
- `kiro`
- `openclaw`
- `opencode`
- `pi`
- `qwen`

When OpenClaw uses the acpx backend, prefer these values for `agentId` unless your acpx config defines custom agent aliases.
If your local Cursor install still exposes ACP as `agent acp`, override the `cursor` agent command in your acpx config instead of changing the built-in default.

Direct acpx CLI usage can also target arbitrary adapters via `--agent <command>`, but that raw escape hatch is an acpx CLI feature (not the normal OpenClaw `agentId` path).

Model control is adapter-capability dependent. Codex ACP model refs are
normalized by OpenClaw before startup. Other harnesses need ACP `models` plus
`session/set_model` support; if a harness exposes neither that ACP capability
nor its own startup model flag, OpenClaw/acpx cannot force a model selection.

## Required config

Core ACP baseline:

```json5
{
  acp: {
    enabled: true,
    // Optional. Default is true; set false to pause ACP dispatch while keeping /acp controls.
    dispatch: { enabled: true },
    backend: "acpx",
    defaultAgent: "codex",
    allowedAgents: [
      "claude",
      "codex",
      "copilot",
      "cursor",
      "droid",
      "gemini",
      "iflow",
      "kilocode",
      "kimi",
      "kiro",
      "openclaw",
      "opencode",
      "pi",
      "qwen",
    ],
    maxConcurrentSessions: 8,
    stream: {
      coalesceIdleMs: 300,
      maxChunkChars: 1200,
    },
    runtime: {
      ttlMinutes: 120,
    },
  },
}
```

Thread binding config is channel-adapter specific. Example for Discord:

```json5
{
  session: {
    threadBindings: {
      enabled: true,
      idleHours: 24,
      maxAgeHours: 0,
    },
  },
  channels: {
    discord: {
      threadBindings: {
        enabled: true,
        spawnSessions: true,
      },
    },
  },
}
```

If thread-bound ACP spawn does not work, verify the adapter feature flag first:

- Discord: `channels.discord.threadBindings.spawnSessions=true`

Current-conversation binds do not require child-thread creation. They require an active conversation context and a channel adapter that exposes ACP conversation bindings.

See [Configuration Reference](/gateway/configuration-reference).

## Plugin setup for acpx backend

Packaged installs use the official `@openclaw/acpx` runtime plugin for ACP.
Install and enable it before using ACP harness sessions:

```bash
openclaw plugins install @openclaw/acpx
openclaw config set plugins.entries.acpx.enabled true
```

Source checkouts can also use the local workspace plugin after `pnpm install`.

Start with:

```text
/acp doctor
```

If you disabled `acpx`, denied it via `plugins.allow` / `plugins.deny`, or want
to switch back to the packaged plugin, use the explicit package path:

```bash
openclaw plugins install @openclaw/acpx
openclaw config set plugins.entries.acpx.enabled true
```

Local workspace install during development:

```bash
openclaw plugins install ./path/to/local/acpx-plugin
```

Then verify backend health:

```text
/acp doctor
```

### acpx command and version configuration

By default, the `acpx` plugin registers the embedded ACP backend without
spawning an ACP agent during Gateway startup. Run `/acp doctor` for an explicit
live probe. Set `OPENCLAW_ACPX_RUNTIME_STARTUP_PROBE=1` only when you need the
Gateway to probe the configured agent at startup.

Override the command or version in plugin config:

```json
{
  "plugins": {
    "entries": {
      "acpx": {
        "enabled": true,
        "config": {
          "command": "../acpx/dist/cli.js",
          "expectedVersion": "any"
        }
      }
    }
  }
}
```

- `command` accepts an absolute path, relative path (resolved from the OpenClaw workspace), or command name.
- `expectedVersion: "any"` disables strict version matching.
- Custom `command` paths disable plugin-local auto-install.

See [Plugins](/tools/plugin).

### Automatic dependency install

When you install OpenClaw globally with `npm install -g openclaw`, the acpx
runtime dependencies (platform-specific binaries) are installed automatically
via a postinstall hook. If the automatic install fails, the gateway still starts
normally and reports the missing dependency through `openclaw acp doctor`.

### Plugin tools MCP bridge

By default, ACPX sessions do **not** expose OpenClaw plugin-registered tools to
the ACP harness.

If you want ACP agents such as Codex or Claude Code to call installed
OpenClaw plugin tools such as memory recall/store, enable the dedicated bridge:

```bash
openclaw config set plugins.entries.acpx.config.pluginToolsMcpBridge true
```

What this does:

- Injects a built-in MCP server named `openclaw-plugin-tools` into ACPX session
  bootstrap.
- Exposes plugin tools already registered by installed and enabled OpenClaw
  plugins.
- Keeps the feature explicit and default-off.

Security and trust notes:

- This expands the ACP harness tool surface.
- ACP agents get access only to plugin tools already active in the gateway.
- Treat this as the same trust boundary as letting those plugins execute in
  OpenClaw itself.
- Review installed plugins before enabling it.

Custom `mcpServers` still work as before. The built-in plugin-tools bridge is an
additional opt-in convenience, not a replacement for generic MCP server config.

### OpenClaw tools MCP bridge

By default, ACPX sessions also do **not** expose built-in OpenClaw tools through
MCP. Enable the separate core-tools bridge when an ACP agent needs selected
built-in tools such as `cron`:

```bash
openclaw config set plugins.entries.acpx.config.openClawToolsMcpBridge true
```

What this does:

- Injects a built-in MCP server named `openclaw-tools` into ACPX session
  bootstrap.
- Exposes selected built-in OpenClaw tools. The initial server exposes `cron`.
- Keeps core-tool exposure explicit and default-off.

### Runtime timeout configuration

The `acpx` plugin defaults embedded runtime turns to a 120-second
timeout. This gives slower harnesses such as Gemini CLI enough time to complete
ACP startup and initialization. Override it if your host needs a different
runtime limit:

```bash
openclaw config set plugins.entries.acpx.config.timeoutSeconds 180
```

Restart the gateway after changing this value.

### Health probe agent configuration

When `/acp doctor` or the opt-in startup probe checks the backend, the bundled
`acpx` plugin probes one harness agent. If `acp.allowedAgents` is set, it
defaults to the first allowed agent; otherwise it defaults to `codex`. If your
deployment needs a different ACP agent for health checks, set the probe agent
explicitly:

```bash
openclaw config set plugins.entries.acpx.config.probeAgent claude
```

Restart the gateway after changing this value.

## Permission configuration

ACP sessions run non-interactively — there is no TTY to approve or deny file-write and shell-exec permission prompts. The acpx plugin provides two config keys that control how permissions are handled:

These ACPX harness permissions are separate from OpenClaw exec approvals and separate from CLI-backend vendor bypass flags such as Claude CLI `--permission-mode bypassPermissions`. ACPX `approve-all` is the harness-level break-glass switch for ACP sessions.

### `permissionMode`

Controls which operations the harness agent can perform without prompting.

| Value           | Behavior                                                  |
| --------------- | --------------------------------------------------------- |
| `approve-all`   | Auto-approve all file writes and shell commands.          |
| `approve-reads` | Auto-approve reads only; writes and exec require prompts. |
| `deny-all`      | Deny all permission prompts.                              |

### `nonInteractivePermissions`

Controls what happens when a permission prompt would be shown but no interactive TTY is available (which is always the case for ACP sessions).

| Value  | Behavior                                                          |
| ------ | ----------------------------------------------------------------- |
| `fail` | Abort the session with `AcpRuntimeError`. **(default)**           |
| `deny` | Silently deny the permission and continue (graceful degradation). |

### Configuration

Set via plugin config:

```bash
openclaw config set plugins.entries.acpx.config.permissionMode approve-all
openclaw config set plugins.entries.acpx.config.nonInteractivePermissions fail
```

Restart the gateway after changing these values.

<Warning>
OpenClaw defaults to `permissionMode=approve-reads` and `nonInteractivePermissions=fail`. In non-interactive ACP sessions, any write or exec that triggers a permission prompt can fail with `AcpRuntimeError: Permission prompt unavailable in non-interactive mode`.

If you need to restrict permissions, set `nonInteractivePermissions` to `deny` so sessions degrade gracefully instead of crashing.
</Warning>

## ACP-specific bootstrap customization

When a Codex ACP session runs through the acpx backend, the model's delivery
model differs from native Codex CLI:

- **Intermediate narration** ("I'm reading X...", "Now checking Y...") is
  delivered to the channel as the agent generates it mid-turn.
- **The final deliverable** (review, file path, answer, summary) must be
  generated as a trailing text block after all tool calls complete. If the
  turn ends at a tool-result boundary with no trailing text, the deliverable
  is silently lost — it was never generated, not merely undelivered.

This distinction matters because ACP users have no terminal to watch; they see
only what the agent explicitly delivers. In native Codex CLI, every generated
token is immediately visible. In ACP mode, the closing message is the only
evidence the task finished.

### CODEX_HOME/BOOTSTRAP.md — the ACP-only injection point

When the acpx backend launches Codex, it sets `CODEX_HOME` to a
deployment-managed directory. Codex loads `$CODEX_HOME/BOOTSTRAP.md` for every
ACP session and does not use this file for native Codex CLI sessions. This
makes it the correct location for behavioral rules that apply only to ACP mode,
without touching the host Codex CLI bootstrap at `~/.codex/BOOTSTRAP.md`.

### Recommended turn-completion rules

The following rules address the most common ACP-mode failure pattern: the agent
completes work internally but never generates the closing user-facing message.
Add them to `$CODEX_HOME/BOOTSTRAP.md`:

```markdown
## ACP Session: Turn Completion Rules

You are running as an ACP agent delivering output to a channel. This changes
the delivery model compared to native Codex CLI:

- Intermediate narration texts are delivered to the channel as you generate
  them mid-turn.
- Your final deliverable must be generated as a trailing text block after all
  tool calls complete. If your turn ends at a tool-result boundary with no
  trailing text, the deliverable is silently lost.

### Hard rules

1. Always close the turn with a user-facing message. After your last tool
   call, generate a text block that delivers the result: the answer, the file
   path, the findings, or a clear summary. Do not stop generating at the
   tool-result boundary.

2. When interrupted mid-deliverable, complete it first. If a new user message
   arrives while a deliverable is pending, send the result before answering
   the follow-up. Exception: the follow-up explicitly cancels the task.

3. "Task complete" means the result was delivered, not just that the work was
   done. If uncertain whether a result was sent, treat it as unsent and send
   it now.
```

<Note>
These rules are placed in `$CODEX_HOME/BOOTSTRAP.md` rather than the shared
host bootstrap so they load only for ACP sessions. Native Codex CLI sessions
are unaffected.
</Note>

## Host-bridge tools

ACP sessions run inside the OpenClaw gateway container. The container does not
have systemd, so `systemctl` and other host-only binaries are unavailable by
default. The host-bridge pattern makes them available transparently via the
bind-mounted `.openclaw/bin/` directory and an SSH tunnel to the host.

### How it works

`~/.openclaw/bin/` is inside the bind-mounted workspace, so its contents
survive container restarts. Tool-call subshells in the codex-acp agent use
non-login `bash -c`, which inherits the container's vanilla
`PATH=/usr/local/bin:/usr/bin:/bin` and never sources profile files. To make shims visible in that environment, `launch.sh` symlinks each shim
into `/usr/local/bin/` at session start and also exports the directory for
the codex-acp process itself:

```bash
# In launch.sh (runs before codex-acp starts)
export PATH="/home/node/.openclaw/bin:${PATH}"
# Seed ~/.profile for any login-shell contexts
grep -q "openclaw/bin" ~/.profile 2>/dev/null || \
  echo 'export PATH="/home/node/.openclaw/bin:${PATH}"' >> ~/.profile
# Symlink into /usr/local/bin so non-login bash -c tool calls find the shim.
docker exec -u root openclaw-openclaw-gateway-1 \
  ln -sf /home/node/.openclaw/bin/systemctl /usr/local/bin/systemctl 2>/dev/null || true
```

The symlink at `/usr/local/bin/systemctl` lives on the container's
ephemeral filesystem and is lost on container or host restart. This does
not break the fix: `launch.sh` is in the bind-mount and runs before
codex-acp starts on every new ACP session, so the symlink is always
recreated before the agent makes its first tool call. The fix is
self-healing and durable across new sessions, container restarts, and
host restarts.

A named shim at `~/.openclaw/bin/systemctl` proxies every `systemctl` call
to the host via SSH. An SSH key pair is stored in `~/.openclaw/ssh/` (also
bind-mounted) and the public key is authorized on the host `ubuntu` user.
The SSH client binary and its dependencies are bundled in
`~/.openclaw/bin/ssh-bundle/` so they survive container restarts even though
they are not installed in the base image:

```
~/.openclaw/bin/
  systemctl              # shim — proxies to host via SSH
  ssh-bundle/
    ssh                  # openssh client binary
    ssh-keygen           # used for key setup
    libcrypto.so.3       # bundled deps not in the base image
    libssl.so.3
    libgssapi_krb5.so.2
    libkrb5.so.3
    libk5crypto.so.3
    libkrb5support.so.0
~/.openclaw/ssh/
  id_ed25519_hostbridge       # private key (rw, bind-mounted)
  id_ed25519_hostbridge.pub   # public key
```

The shim uses `host.docker.internal` (mapped to the host gateway via
`extra_hosts` in `docker-compose.yml`) and sets `XDG_RUNTIME_DIR`
automatically so `systemctl --user` commands resolve to the correct host
user session:

```bash
#!/bin/bash
SSH_BUNDLE="/home/node/.openclaw/bin/ssh-bundle"
SSH_KEY="/home/node/.openclaw/ssh/id_ed25519_hostbridge"
exec env LD_LIBRARY_PATH="${SSH_BUNDLE}:${LD_LIBRARY_PATH}" \
  "${SSH_BUNDLE}/ssh" \
  -i "${SSH_KEY}" \
  -o StrictHostKeyChecking=no \
  -o BatchMode=yes \
  -o ConnectTimeout=5 \
  ubuntu@host.docker.internal \
  "XDG_RUNTIME_DIR=/run/user/\$(id -u) systemctl $(printf '%q ' "$@")"
```

### Initial setup

This is a one-time setup when first deploying the codex-acp integration.
Run the following on the host to populate the bundle and generate the key:

```bash
# 1. Install openssh-client temporarily (apt cache must be fresh)
docker exec -u root openclaw-openclaw-gateway-1 apt-get update -qq
docker exec -u root openclaw-openclaw-gateway-1 \
  apt-get install -y --no-install-recommends openssh-client -qq

# 2. Create bundle directory and copy binary + deps
docker exec -u root openclaw-openclaw-gateway-1 bash -c '
  mkdir -p /home/node/.openclaw/bin/ssh-bundle
  cp /usr/bin/ssh /usr/bin/ssh-keygen /home/node/.openclaw/bin/ssh-bundle/
  for lib in libcrypto.so.3 libssl.so.3 libgssapi_krb5.so.2 \
             libkrb5.so.3 libk5crypto.so.3 libkrb5support.so.0; do
    cp /lib/aarch64-linux-gnu/$lib /home/node/.openclaw/bin/ssh-bundle/
  done
  chown -R node:node /home/node/.openclaw/bin
'

# 3. Generate the SSH key pair as the node user
docker exec -u node openclaw-openclaw-gateway-1 bash -c '
  mkdir -p /home/node/.openclaw/ssh && chmod 700 /home/node/.openclaw/ssh
  LD_LIBRARY_PATH=/home/node/.openclaw/bin/ssh-bundle \
    /home/node/.openclaw/bin/ssh-bundle/ssh-keygen \
    -t ed25519 -f /home/node/.openclaw/ssh/id_ed25519_hostbridge \
    -N "" -C "openclaw-acp-hostbridge"
  cat /home/node/.openclaw/ssh/id_ed25519_hostbridge.pub
'

# 4. Authorize the printed public key on the host
echo "<paste public key here>" >> ~/.ssh/authorized_keys
```

<Note>
The library paths above use `aarch64-linux-gnu` for ARM64 hosts. On x86-64
hosts, replace with `x86_64-linux-gnu`.
</Note>

### Adding new host-bridge tools

Any executable placed in `~/.openclaw/bin/` is automatically available to
ACP sessions. Follow the same pattern for other host-only binaries: bundle
any non-baseline shared libraries alongside the binary in a subdirectory
and set `LD_LIBRARY_PATH` in a wrapper shim if needed.

## Related

- [ACP agents](/tools/acp-agents) — overview, operator runbook, concepts
- [Sub-agents](/tools/subagents)
- [Multi-agent routing](/concepts/multi-agent)
