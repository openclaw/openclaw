# Private Mode

Private mode is an in-progress hardening profile for running OpenClaw against proprietary data.

Phase 1 adds:

- a `privateMode` config surface
- startup validation for local-only model providers
- startup validation for local-only embedding providers
- fail-closed rejection of the default remote model when `privateMode.enabled` is true

Current behavior:

- `privateMode` is validation-only in this phase
- runtime tool enforcement is not implemented yet
- filesystem, elevated exec, skills, and audit settings are accepted in config now so later phases can enforce them without changing the config shape

Recommended Phase 1 baseline:

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
- The safer long-term default for sandbox workspace exposure is `workspaceAccessDefault: "none"` with explicit read-only corpus mounts.
