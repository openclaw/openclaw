# Migration from auto-recall-mnemostack

This plugin is the universal Phase 1 extraction of `auto-recall-mnemostack`.

## Removed workspace-specific behavior

- No hardcoded `/root/.openclaw/workspace/...` paths.
- No mnemostack-specific daemon route assumptions.
- No `recall-selfeval.sh` default.
- No strategy-memory side lookup.
- No MemorySearchBackend yet; SDK integration is Phase 2.

## Map old config to new config

Old mnemostack daemon:

```json
{
  "recallDaemonUrl": "http://127.0.0.1:18793",
  "recallDaemonTimeoutMs": 9000,
  "minConfidence": 0.4
}
```

New HTTP backend:

```json
{
  "minConfidence": 0.4,
  "backends": [
    {
      "type": "http",
      "name": "mnemostack",
      "url": "http://127.0.0.1:18793/recall-answer",
      "timeoutMs": 9000,
      "responseMapping": {
        "answerPath": "answer",
        "confidencePath": "confidence",
        "sourcesPath": "sources",
        "degradedPath": "degraded"
      }
    }
  ]
}
```

Old script fallback:

```json
{
  "recallScript": "/path/to/recall-selfeval.sh",
  "timeoutMs": 7000
}
```

New script backend:

```json
{
  "backends": [
    {
      "type": "script",
      "name": "selfeval",
      "command": "/path/to/recall-selfeval.sh",
      "args": ["--answer"],
      "queryMode": "stdin",
      "protocol": "text",
      "timeoutMs": 7000
    }
  ]
}
```

To preserve daemon-then-script fallback:

```json
{
  "backends": [
    { "type": "http", "name": "mnemostack", "url": "http://127.0.0.1:18793/recall-answer" },
    {
      "type": "script",
      "name": "selfeval",
      "command": "/path/to/recall-selfeval.sh",
      "args": ["--answer"],
      "queryMode": "stdin",
      "protocol": "text"
    }
  ]
}
```

## Triggers

Old `triggersPath` becomes:

```json
{
  "triggers": { "customPath": "/path/to/triggers.json" }
}
```

Reload is now explicit with `SIGUSR2`; malformed reloads keep the previous valid snapshot.

## Cache

Old:

```json
{ "cacheSuccessTtlMs": 1800000, "cacheNegativeTtlMs": 600000, "cacheMaxEntries": 500 }
```

New:

```json
{
  "cache": {
    "okTtlMs": 1800000,
    "notFoundTtlMs": 600000,
    "errorTtlMs": 0,
    "maxEntries": 500
  }
}
```

Timeout and other infrastructure failures are not negative-cached.
