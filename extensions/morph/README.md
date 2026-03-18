# @openclaw/morph

Bundled Morph plugin for **OpenClaw**.

Provides:

- **Fast compaction** — 33k tok/s context compression via the Morph `/v1/compact` API
- **Codebase search** — AI-powered parallel grep/read via WarpGrep SDK

Docs: `https://docs.openclaw.ai/concepts/compaction`
Plugin system: `https://docs.openclaw.ai/plugin`

## Setup

The plugin is bundled with OpenClaw. Enable it and set your API key:

```bash
# Set API key via env var (recommended)
export MORPH_API_KEY="morph-..."

# Or configure via plugin config
openclaw config set plugins.entries.morph.config.apiKey "morph-..."
```

Then set the compaction provider:

```bash
openclaw config set agents.defaults.compaction.provider morph
```

Check status:

```bash
openclaw morph status
```

## Configuration

Plugin config lives under `plugins.entries.morph.config`:

| Key                       | Type     | Default                    | Description                         |
| ------------------------- | -------- | -------------------------- | ----------------------------------- |
| `apiKey`                  | string   | `$MORPH_API_KEY`           | Morph API key                       |
| `apiUrl`                  | string   | `https://api.morphllm.com` | API base URL                        |
| `compressionRatio`        | number   | `0.3`                      | Target compression ratio (0.05-1.0) |
| `codebaseSearch.enabled`  | boolean  | `true`                     | Enable codebase search tool         |
| `codebaseSearch.timeout`  | number   | SDK default                | Request timeout in ms               |
| `codebaseSearch.excludes` | string[] | `[]`                       | Glob patterns to exclude            |

Get your API key at: https://morphllm.com
