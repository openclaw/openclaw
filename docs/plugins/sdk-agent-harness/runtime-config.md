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
      "model": "openai/gpt-5.6-sol"
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
        "model": "openai/gpt-5.6-sol",
        "models": {
          "openai/gpt-5.6-sol": {
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
