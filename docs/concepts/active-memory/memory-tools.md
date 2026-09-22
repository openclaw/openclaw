---
summary: "The concrete recall tools the blocking sub-agent may call, and per-provider setups for built-in memory, LanceDB, and Lossless Claw."
read_when:
  - You are choosing which recall tools active memory may call
  - You are wiring active memory to a specific memory provider
title: "Memory tools"
---

## Memory tools

`config.toolsAllow` sets the concrete tool names the blocking sub-agent may
call for advanced Active Memory. Defaults depend on the current memory provider:

| Memory provider | Default `toolsAllow`              |
| --------------- | --------------------------------- |
| Built-in memory | `["memory_search", "memory_get"]` |
| LanceDB         | `["memory_recall"]`               |

`toolsAllow` is a limit, not a permission grant. Before starting recall, Active
Memory filters these names through the parent agent's finalized tool policy.
A plugin can register a tool that the parent agent's selected profile excludes.
Use explicit `tools.alsoAllow` entries to extend a restrictive profile, as in
the [Lossless Claw example](/concepts/active-memory/memory-tools#lossless-claw). These grants also give the parent
agent access to the named tools; they are not recall-only permissions. Explicit
denies and provider, agent, and sandbox restrictions still apply, and recall
cannot continue after the parent turn's tool authority expires.
If only some configured tools are allowed, recall can still run with that
smaller set. For example, `memory_search` may remain available even when the
Lossless Claw tools are excluded.

If none of the configured tools are available, or the sub-agent run fails,
active memory skips recall for that turn and the main reply continues
without memory context. For custom recall tools, non-empty model-visible
tool output counts as recall evidence unless structured result fields
explicitly report an empty result or failure.

`toolsAllow` only accepts concrete memory tool names: wildcards, `group:*`
entries, and core agent tools (`read`, `exec`, `message`, `web_search`, and
similar) are silently filtered out before the hidden sub-agent starts.

### Built-in memory

No explicit `toolsAllow` needed:

```json5
{
  plugins: {
    entries: {
      "active-memory": {
        enabled: true,
        config: {
          agents: ["main"],
          // Default: ["memory_search", "memory_get"]
        },
      },
    },
  },
}
```

### LanceDB memory

After [installing and configuring LanceDB](/plugins/memory-lancedb), Active
Memory automatically uses `memory_recall`; no explicit `toolsAllow` is needed:

```json5
{
  plugins: {
    entries: {
      "active-memory": {
        enabled: true,
        config: {
          agents: ["main"],
          promptAppend: "Use memory_recall for long-term user preferences, past decisions, and previously discussed topics. If recall finds nothing useful, return NONE.",
        },
      },
    },
  },
}
```

This is the advanced Active Memory path for LanceDB's own stored memories.
`memory.search.rememberAcrossConversations` does not expose private session
transcripts through `memory_recall`. Use LanceDB's auto-recall or the advanced
configuration above when LanceDB is the active memory provider.

### Lossless Claw

[Lossless Claw](https://github.com/martian-engineering/lossless-claw) is an
external context-engine plugin (`openclaw plugins install
@martian-engineering/lossless-claw`) with its own recall tools. Set it up as
a context engine first; see [Context engine](/concepts/context-engine). Then
grant its recall tools to the parent agent and point Active Memory at them.
This example keeps the `main` agent on the restrictive `coding` profile and
adds only the three named Lossless Claw tools through
`agents.entries.main.tools.alsoAllow`. Merge these entries into that agent's
existing tool configuration. Keep your selected profile and any other required
grants and denies. This example assumes that agent scope does not also define
`tools.allow`: `allow` and `alsoAllow` cannot be combined in the same scope.
A later allowlist cannot restore tools excluded by a profile. See
[Tool policy](/gateway/config-tools) before adapting an existing layered allowlist:

```json5
{
  agents: {
    entries: {
      main: {
        tools: {
          profile: "coding",
          alsoAllow: ["lcm_grep", "lcm_describe", "lcm_expand_query"],
        },
      },
    },
  },
  plugins: {
    slots: {
      contextEngine: "lossless-claw",
    },
    entries: {
      "lossless-claw": {
        enabled: true,
      },
      "active-memory": {
        enabled: true,
        config: {
          agents: ["main"],
          toolsAllow: ["memory_search", "lcm_grep", "lcm_describe", "lcm_expand_query"],
          promptAppend: "Use lcm_grep first for compacted conversation recall. Use lcm_describe to inspect a specific summary. Use lcm_expand_query only when the latest user message needs exact details that may have been compacted away. Return NONE if the retrieved context is not clearly useful.",
        },
      },
    },
  },
}
```

Do not add `lcm_expand` to `toolsAllow` here; Lossless Claw uses it as a
lower-level tool for delegated expansion, not meant for the top-level
active-memory sub-agent. Lossless Claw changes context assembly without
replacing the current memory provider. Keep `memory_search` in `toolsAllow`
when also using `rememberAcrossConversations`; an LCM-only tool list remains
valid for advanced Active Memory but disables the product transcript-recall
path.
