---
summary: "Operator config for the native Codex harness mode and for strict provider or model runtime policy"
read_when:
  - You are enabling the bundled Codex harness for embedded turns
  - You want harness selection to fail instead of falling back
  - You need provider, model, or per-agent `agentRuntime` config examples
title: "Agent harness runtime configuration"
sidebarTitle: "Runtime configuration"
---

Operator configuration: turning on the bundled native Codex mode, and pinning provider, model, or per-agent runtime policy so a missing harness fails instead of routing through the embedded runtime. Part of the [Agent harness plugins](/plugins/sdk-agent-harness) reference.

## Native Codex harness mode

The bundled `codex` harness is the native Codex mode for embedded OpenClaw
agent turns. Enable the bundled `codex` plugin first, and include `codex` in
`plugins.allow` if your config uses a restrictive allowlist. Native app-server
configs should use `openai/gpt-*`; OpenAI agent turns select the Codex harness
only when the effective route declares Codex compatibility. Legacy Codex model
refs should be repaired with `openclaw doctor --fix`, and legacy `codex/*`
model refs remain compatibility aliases for the native harness.

When this mode runs, Codex owns the native thread id, resume behavior,
compaction, and app-server execution. OpenClaw still owns the chat channel,
visible transcript mirror, tool policy, approvals, media delivery, and session
selection. Use provider/model `agentRuntime.id: "codex"` to require a registered
Codex harness. Unsupported routes/auth fail closed unless the harness declares
an exact-request fallback before execution. Codex runtime failures are not
retried through another runtime.

## Agents API environment

The `agentsapi` plugin accepts `plugins.entries.agentsapi.config.environment` with
the values `openai_hosted` and `self_hosted`. Omitted configuration uses
`openai_hosted`.

For `self_hosted`, OpenClaw sends its prepared absolute workspace path as the
Agents API `workspace_directory`. The executor must already have that directory
at the same path. Before selecting this mode, configure an operator-owned
[webhook controller](https://developers.openai.com/api/docs/guides/agents-api/environments/lifecycle#start-compute-from-webhooks)
for the Gateway's sessions. The controller retrieves each session's environment
ID and remote URL through the authenticated Agents API and connects its executor,
following the [official self-hosted setup](https://developers.openai.com/api/docs/guides/agents-api/environments/self-hosted).
It owns startup, reconnection, and cleanup. OpenClaw does not launch or provision
executors through this setting. Input submission has a 60-second HTTP deadline,
including any wait for the executor to connect. The controller must connect
promptly; the API's longer connection window does not extend this deadline.

Set `plugins.entries.agentsapi.config.hostExecutorSkillDirectories` to absolute
paths on the executor host machine. These directories must already be set up
with the skill files and be available to the Agents API harness through the
executor. OpenClaw sends the paths as the Agents API `capability_directories`
field. The harness discovers and reads skills through that executor; OpenClaw
does not copy or install the files.
This explicit directory selection uses native skill discovery, without OpenClaw's
per-skill eligibility filters. Gateway function policies still apply.
Omitted and empty lists keep the existing behavior. Hosted sessions ignore this list.

Reset the OpenClaw session after changing its environment or a self-hosted
workspace or skill directories. Existing hosted sessions continue with omitted or explicit
`openai_hosted` configuration. This selection does not expand the MVP's existing
tool or media capabilities.

## Agents API HTTP MCP servers

The Agents API harness reads enabled HTTP servers from `mcp.servers` and plugin MCP
bundles. Set `transport: "streamable-http"`, a `url`, and optional `headers` on each
server. HTTP connections run from the session's execution environment, including
the self-hosted executor for private-network services. Native MCP owns discovery
and execution; OpenClaw does not create another Gateway transport for these tools.

Exact `toolFilter.include` names are forwarded as the native allowlist. Exclusions
and session tool denials require an explicit include list and are subtracted from
it. Wildcards, Gateway-managed OAuth, legacy SSE and custom TLS settings are not
supported. Unsupported servers and servers whose headers cannot be resolved are
omitted with an error log, while supported servers remain available. This includes
requester-scoped connections and URL-only definitions, which retain the legacy SSE
default. Changes to effective MCP configuration or credentials require a session
reset.

Stdio MCP forwarding remains a deferred implementation gap. The executor's native
MCP lifecycle will own those processes when support is added.

Harness authors can reuse `loadAgentHarnessMcpConfig` from
`openclaw/plugin-sdk/agent-harness-runtime` to merge enabled bundle and operator
definitions with session server overrides. It returns static connection config,
diagnostics, and the names of omitted requester-scoped servers, without opening
connections. The same SDK exports `decodeHeaderEnvPlaceholder` for recognizing
`${NAME}` and `Bearer ${NAME}` header references; the harness resolves the value
for its own transport.
`resolveOpenClawMcpTransportAlias` resolves CLI `type` aliases using OpenClaw's
canonical mapping; an explicit `transport` takes precedence.

## Runtime strictness

By default, OpenClaw uses `auto` provider/model runtime policy: registered
plugin harnesses can claim compatible effective routes, and the embedded
runtime handles the turn when none match. A provider/model prefix alone never
selects a harness. Use an explicit provider/model plugin runtime such as
`agentRuntime.id: "codex"` when missing harness selection should fail instead
of routing through the embedded runtime. Explicit selection does not make an
incompatible route compatible. Selected plugin harness failures always fail
hard. This does not block an explicit provider/model
`agentRuntime.id: "openclaw"`.

To request Codex for embedded runs:

```json
{
  "models": {
    "providers": {
      "openai": {
        "agentRuntime": {
          "id": "codex"
        }
      }
    }
  },
  "agents": {
    "defaults": {
      "model": "openai/gpt-6-astra"
    }
  }
}
```

If you want a CLI backend for one canonical model, put the runtime on that
model entry:

```json
{
  "agents": {
    "defaults": {
      "model": "anthropic/claude-opus-5",
      "models": {
        "anthropic/claude-opus-5": {
          "agentRuntime": {
            "id": "claude-cli"
          }
        }
      }
    }
  }
}
```

Per-agent overrides use the same model-scoped shape:

```json
{
  "agents": {
    "entries": {
      "codex-only": {
        "default": true,
        "model": "openai/gpt-6-astra",
        "models": {
          "openai/gpt-6-astra": {
            "agentRuntime": { "id": "codex" }
          }
        }
      }
    }
  }
}
```

Legacy whole-agent runtime examples like this are ignored:

```json validate=false
{
  "agents": {
    "defaults": {
      "agentRuntime": {
        "id": "codex"
      }
    }
  }
}
```

With an explicit plugin runtime, a session fails early when the requested
harness is not registered or rejects the resolved provider/model without a
declared fallback. An authored transport override may select OpenClaw through
that fallback even with an explicit runtime. To prove native execution, inspect
the actual harness in the completed result; configured intent alone is not proof.

This setting only controls the embedded agent harness. It does not disable
image, video, music, TTS, PDF, or other provider-specific model routing.
