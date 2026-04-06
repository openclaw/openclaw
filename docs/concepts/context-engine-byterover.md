---
title: "ByteRover Context Engine"
summary: "Retrieval-augmented context via the ByteRover plugin"
read_when:
  - You want a retrieval-augmented context engine for OpenClaw
  - You want curated conversation knowledge injected into agent prompts
  - You are setting up the ByteRover context engine plugin
---

# ByteRover Context Engine

[ByteRover](https://www.byterover.dev) adds retrieval-augmented context to
OpenClaw. It curates conversation knowledge after every turn and retrieves
relevant context before each prompt, giving your agent access to curated
knowledge from past conversations without manual memory management.

## What it provides

- **Automatic curation** -- after every turn, ByteRover extracts facts,
  decisions, technical details, and preferences from the conversation and
  stores them in a local context tree.
- **Retrieval-augmented prompts** -- before each model run, ByteRover queries
  the context tree with the current user message and injects relevant
  knowledge into the system prompt.
- **Noise filtering** -- trivial messages (greetings, acknowledgments,
  one-word replies) are automatically skipped during both curation and
  retrieval.
- **Hands-off operation** -- no need to say "remember this" or structure
  messages in any particular way. The plugin adapts to natural conversation.

## Getting started

### Prerequisites

- OpenClaw 2026.3.22 or later (context engine plugin support with prompt
  passthrough)
- The `brv` CLI installed ([install guide](https://docs.byterover.dev/quickstart))

### Install the plugin

```bash
openclaw plugins install @byterover/byterover@latest
```

For local development, link your working copy instead:

```bash
openclaw plugins install --link /path/to/brv-openclaw-plugin
```

The install command records the plugin, enables it, and sets the
`contextEngine` slot to `"byterover"`.

### Verify

```bash
openclaw plugins list
openclaw doctor
```

Restart the gateway after installing.

## Configuration

Settings live under `plugins.entries.byterover.config`:

```json5
{
  plugins: {
    slots: {
      contextEngine: "byterover",
    },
    entries: {
      byterover: {
        enabled: true,
        config: {
          brvPath: "/path/to/brv", // optional, defaults to "brv" from PATH
          cwd: "/path/to/project", // must have .brv/ initialized
          queryTimeoutMs: 12000, // timeout for brv query (default: 12000)
          curateTimeoutMs: 60000, // timeout for brv curate (default: 60000)
        },
      },
    },
  },
}
```

| Setting           | Default | Description                                                                             |
| ----------------- | ------- | --------------------------------------------------------------------------------------- |
| `brvPath`         | `"brv"` | Path to the brv CLI binary. Resolved from PATH if not set.                              |
| `cwd`             | cwd     | Working directory for brv commands. Must contain an initialized `.brv/` context tree.   |
| `queryTimeoutMs`  | `12000` | Timeout for `brv query` calls in ms. Effective assemble deadline is capped at 10000 ms. |
| `curateTimeoutMs` | `60000` | Timeout for `brv curate` calls in ms.                                                   |

## How it works

ByteRover participates in two context engine lifecycle points:

### Assemble (before each prompt)

When a user sends a message, ByteRover:

1. Extracts the user query (stripping OpenClaw metadata)
2. Skips trivially short queries (under 5 characters)
3. Runs `brv query` with the user message against the local context tree
4. Wraps the result in a `systemPromptAddition` that gets prepended to the
   system prompt

The model sees relevant curated knowledge alongside its normal context,
without any extra tool calls or latency.

### After turn (after each response)

After the agent responds, ByteRover:

1. Extracts new messages from the turn
2. Strips metadata and tags to get clean conversation text
3. Attributes messages with sender name and timestamp
4. Runs `brv curate --detach` to asynchronously store knowledge

Curation runs in the background (via `--detach`), so it does not block the
next user interaction.

### Other lifecycle points

- **Ingest** -- no-op. ByteRover uses `afterTurn` for batch ingestion instead
  of per-message ingest.
- **Compact** -- not owned. ByteRover sets `ownsCompaction: false` and lets
  the runtime handle compaction via the built-in path.

## ByteRover vs other context engines

|                  | Legacy (builtin)         | Lossless-Claw                  | ByteRover                     |
| ---------------- | ------------------------ | ------------------------------ | ----------------------------- |
| **Approach**     | Sliding window           | DAG-based summarization        | Retrieval-augmented curation  |
| **Storage**      | Session file             | SQLite database                | Local context tree (brv)      |
| **Compaction**   | Truncates older messages | Summarizes into DAG nodes      | Delegates to runtime          |
| **Retrieval**    | None                     | Tools (grep, describe, expand) | Automatic per-prompt query    |
| **Curation**     | None                     | Persists every message         | Extracts high-value knowledge |
| **Dependencies** | None (builtin)           | Plugin install                 | Plugin + brv CLI              |

## Troubleshooting

- **"Context Engine byterover is not registered"** -- the plugin failed to
  load. Check that `plugins.entries.byterover.enabled` is `true` and run
  `openclaw plugins list` to verify it appears.
- **No context injected** -- check that `cwd` points to a directory with
  `.brv/` initialized. Run `brv status` in that directory to verify.
- **Query timeouts** -- if `brv query` is slow, lower `queryTimeoutMs` or
  check that the brv daemon is running.
- **Curate not running** -- check gateway logs for `afterTurn curating`
  messages. Ensure `brvPath` resolves to a valid brv binary.

## Further reading

- [Plugin source code](https://github.com/campfirein/brv-openclaw-plugin)
- [ByteRover documentation](https://docs.byterover.dev/)
- [Context Engine](/concepts/context-engine) -- how plugin context engines work
- [Compaction](/concepts/compaction) -- summarizing long conversations
