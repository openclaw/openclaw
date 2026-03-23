# Private Mode

Private mode is an in-progress hardening profile for running OpenClaw against proprietary data.

Phase 0/1 adds:

- a `privateMode` config surface
- startup validation for local-only model providers
- startup validation for local-only embedding providers
- fail-closed rejection of the default remote model when `privateMode.enabled` is true

Current behavior:

- startup validation rejects disallowed remote model providers and model refs
- startup validation rejects disallowed remote embedding providers and fallbacks
- runtime skill env injection can be blocked with `privateMode.skills.blockEnvInjection`
- runtime elevated exec can be blocked with `privateMode.execution.disableElevatedExec`
- runtime embedding provider selection rejects remote providers in private mode
- runtime model fallback chains are filtered to `privateMode.localOnly.allowedProviders`
- filesystem, sandbox, and audit settings are accepted in config, but their remaining runtime enforcement is still in progress

Recommended current baseline:

```json
{
  "privateMode": {
    "enabled": true,
    "localOnly": {
      "allowedProviders": ["ollama"],
      "failOnDisallowedProviders": true
    },
    "embeddings": {
      "provider": "local",
      "allowFtsFallback": true
    },
    "filesystem": {
      "workspaceAccessDefault": "none",
      "allowedRoots": ["/data/proprietary", "/home/user/scratch"],
      "blockAbsolutePaths": true
    },
    "execution": {
      "disableElevatedExec": true,
      "sandboxMode": "all",
      "blockHostExec": true
    },
    "skills": {
      "blockEnvInjection": true
    },
    "audit": {
      "enabled": true,
      "redactContent": true
    }
  },
  "agents": {
    "defaults": {
      "model": "ollama/qwen3:8b",
      "memorySearch": {
        "provider": "local",
        "fallback": "none"
      }
    }
  }
}
```

Notes:

- If you enable `privateMode` without overriding the default model, validation fails because the built-in default is `anthropic/claude-opus-4-6`.
- In this phase, `memorySearch.provider` and `memorySearch.fallback` must stay within `local`, `ollama`, or `none`.
- Runtime model fallback enforcement only allows providers from `privateMode.localOnly.allowedProviders` when private mode is enabled.
- Runtime embedding enforcement blocks remote auto-selection and explicit remote embedding providers in private mode.
- Runtime elevated exec and skill env injection enforcement depend on `privateMode.execution.disableElevatedExec` and `privateMode.skills.blockEnvInjection`.
- The safer long-term default for sandbox workspace exposure is `workspaceAccessDefault: "none"` with explicit read-only corpus mounts.
