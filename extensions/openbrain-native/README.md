# openbrain-native

Native OpenBrain MCP bridge for OpenClaw.

## Tools exposed

- `openbrain_search`
- `openbrain_capture`
- `openbrain_list_recent`

All tools are registered as optional plugin tools.

## Canonical config example

```json5
plugins: {
  entries: {
    "openbrain-native": {
      enabled: true,
      config: {
        // Option A: URL already contains key/query auth
        url: "https://<supabase>/functions/v1/open-brain-mcp?key=<...>",

        // Option B: bearer token auth
        // apiKey: "<token>",

        envelopeMode: true,
        defaultLimit: 8,
        timeoutMs: 25000
      }
    }
  },
  allow: ["openbrain-native", "telegram"]
}

// Profile-safe optional tool enablement
tools: {
  profile: "coding",
  alsoAllow: [
    "openbrain-native",
    "openbrain_search",
    "openbrain_capture",
    "openbrain_list_recent"
  ]
}

agents: {
  list: [
    {
      id: "main",
      tools: {
        alsoAllow: [
          "openbrain-native",
          "openbrain_search",
          "openbrain_capture",
          "openbrain_list_recent"
        ]
      }
    }
  ]
}
```

## Metadata behavior

OpenBrain MCP deployments that only accept `capture_thought({ content })` can still keep category/tag semantics via envelope mode:

```text
[OBMETA v1]
category: Decisions
tags: platform:azure, intent:preflight
source: openclaw-main
---
Complete read-only preflight before any Azure write operation.
```

Disable with `envelopeMode: false` if your server supports structured metadata directly.
