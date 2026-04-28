# auto-recall

Universal OpenClaw community plugin that detects recall-style user questions, queries one or more configured recall backends, and injects a bounded memory answer into `before_prompt_build` context.

It has no built-in memory store. You provide an HTTP service or a script backend.

## Quick start

```json
{
  "enabled": true,
  "allowedChatTypes": ["direct", "group"],
  "minConfidence": 0.4,
  "backends": [
    {
      "type": "http",
      "url": "http://127.0.0.1:18793/recall",
      "timeoutMs": 7000
    }
  ]
}
```

The HTTP backend receives JSON by default:

```json
{
  "query": "user text",
  "normalizedQuery": "user text normalized for cache",
  "maxResults": 5,
  "minConfidence": 0.4,
  "trigger": { "patternId": "memory_keyword", "matchedText": "remember" },
  "session": { "agentId": "main", "provider": "telegram", "chatType": "direct" }
}
```

Expected JSON response:

```json
{
  "status": "ok",
  "answer": "The thing you decided was...",
  "confidence": 0.86,
  "sources": [{ "title": "notes.md", "uri": "file:///notes.md", "score": 0.74 }]
}
```

`status` can be `ok`, `not_found`, `degraded`, or `error`.

## Security notes

HTTP backends call the URL you configure from the OpenClaw Gateway process. Treat this as an SSRF-capable setting: do not expose plugin configuration to untrusted users, and prefer loopback/private endpoints you control. The plugin does not try to validate whether your configured URL is safe.

Script backends never use `shell: true`. Configure `command` and `args` arrays; user text is passed via stdin by default or as a single argument if `queryMode: "arg"` is set.

## Config reference

| Key                                 | Default              | Description                                                                                   |
| ----------------------------------- | -------------------- | --------------------------------------------------------------------------------------------- |
| `enabled`                           | `true`               | Register the hook when plugin is enabled.                                                     |
| `agents`                            | `[]`                 | Optional allow-list of agent ids. Empty means all.                                            |
| `allowedChatTypes`                  | `["direct","group"]` | Chat types allowed for recall. Missing/unknown chat type is skipped.                          |
| `timeoutMs`                         | `7000`               | Per-hook timeout passed to backends via `AbortSignal`.                                        |
| `maxResults`                        | `5`                  | Hint for backend result count.                                                                |
| `minConfidence`                     | `0.4`                | Minimum confidence required for injection.                                                    |
| `allowDegraded`                     | `false`              | Allow `degraded` backend results to inject.                                                   |
| `logPath`                           | unset                | Optional JSONL diagnostics path. If unwritable, warns once and continues.                     |
| `recallMinChars` / `recallMaxChars` | `8` / `8000`         | Bounds input sent to backends.                                                                |
| `backends`                          | `[]`                 | Ordered backend chain.                                                                        |
| `triggers.customPath`               | unset                | Optional `triggers.json`; reload with `SIGUSR2`. Malformed reload keeps last-known-good.      |
| `triggers.reloadSignal`             | `SIGUSR2`            | Process signal used for trigger reload. Set to `false` to avoid process-wide signal handlers. |
| `cache.enabled`                     | `true`               | In-memory cache.                                                                              |
| `cache.okTtlMs`                     | `1800000`            | TTL for successful answers.                                                                   |
| `cache.notFoundTtlMs`               | `600000`             | TTL for `not_found` negative cache.                                                           |
| `cache.degradedTtlMs`               | `1800000`            | TTL for `degraded` candidates.                                                                |
| `cache.errorTtlMs`                  | `0`                  | Error cache TTL. Timeout/infra failures are not cached.                                       |
| `cache.maxEntries`                  | `500`                | Max cache entries; expired/LRU sweep.                                                         |
| `injection.maxLength`               | `2000`               | Maximum injected body length.                                                                 |
| `injection.tag`                     | `active_memory`      | XML-ish envelope tag.                                                                         |

## Backend chain behavior

Backends are tried in order. The chain stops on the first `ok` result with `confidence >= minConfidence`. `not_found` and `error` continue to the next backend. `degraded` results are saved as candidates and injected only when `allowDegraded: true`.

Cache keys include backend type, backend name, backend config hash, optional backend cache suffix, and normalized query text. In-flight requests with the same key are de-duplicated and cleaned up with `finally` on all paths.

## HTTP backend

```json
{
  "type": "http",
  "name": "local-rag",
  "url": "http://127.0.0.1:18793/recall",
  "method": "POST",
  "headers": { "authorization": "Bearer ..." },
  "timeoutMs": 7000,
  "maxResponseBytes": 262144,
  "allowedHosts": ["127.0.0.1"],
  "requestMode": "default",
  "responseMapping": {
    "answerPath": "answer",
    "confidencePath": "confidence",
    "sourcesPath": "sources",
    "statusPath": "status",
    "degradedPath": "degraded"
  }
}
```

`requestMode` options:

- `default`: structured payload shown above.
- `query`: `{ "query": text }`.
- `normalizedQuery`: `{ "query": normalizedText }`.
- `text`: raw text body.

JSON response parsing is the default and only supported mode in Phase 1.

When `allowedHosts` is set, the backend validates the configured URL host and does not follow HTTP redirects automatically. Redirect responses are returned as `redirect_blocked` so an allow-listed local endpoint cannot bounce recall traffic to an internal metadata service or another unexpected host.

## Script backend

```json
{
  "type": "script",
  "name": "local-script",
  "command": "/usr/local/bin/recall-answer",
  "args": ["--json"],
  "queryMode": "stdin",
  "protocol": "json",
  "timeoutMs": 7000,
  "maxStdoutBytes": 262144,
  "maxStderrBytes": 32768,
  "cwd": "/safe/working/dir",
  "env": { "RECALL_MODE": "answer" }
}
```

For argument mode:

```json
{ "queryMode": "arg", "queryArg": "{query}" }
```

Supported output protocols:

```json
{ "status": "ok", "answer": "...", "confidence": 0.87, "sources": [] }
```

or text:

```text
ANSWER: ...
CONFIDENCE: 0.87
SOURCES:
  - source one
```

## Triggers

Bilingual English/Russian defaults are embedded in code. You can add triggers for any language — just provide your own `triggers.json` with locale-specific keywords and phrases. The plugin is language-agnostic; built-in defaults cover English and Russian as a starting point.

Custom `triggers.json` can override/extend categories:

```json
{
  "memory_keywords": ["remember", "помнишь"],
  "past_references": ["last time", "мы решили"],
  "named_entities": ["Project Codename"],
  "internal_prompt_denylist": ["You are a memory search agent"],
  "term_whitelist": ["OpenClaw"]
}
```

Send `SIGUSR2` to the Gateway process to reload. If the file is malformed, the plugin logs `triggers_reload_failed` and keeps the last-known-good immutable snapshot for in-flight hooks. Set `triggers.reloadSignal` to `false` if the host process already owns `SIGUSR2`.
