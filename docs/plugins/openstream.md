---
summary: "OpenStream plugin: Ollama diagnostics, prompt guidance, and long-context / reasoning heuristics"
read_when:
  - You run OpenClaw on Ollama or other open-source local models
  - You want stronger diagnostics before changing provider/runtime behavior
  - You want an installable plugin surface for OpenStream-style guidance
title: "OpenStream Plugin"
---

# OpenStream (plugin)

OpenStream is a bundled OpenClaw companion plugin for Ollama-heavy deployments.

It gives OpenClaw a stable, installable surface for:

- Ollama diagnostics
- long-context and reasoning-model heuristics
- cached prompt guidance for open-source tool-calling behavior
- generated config snippets for plugin mode and deeper runtime bridge mode

## What it is not

OpenStream does **not** claim to replace the deepest raw stream/parser path yet.

Think of it as:

- a plugin-native guidance and diagnosis layer now
- a staging point for narrower runtime improvements later

## Enable

Bundled plugins ship with OpenClaw but start disabled:

```bash
openclaw plugins enable openstream
openclaw plugins info openstream
```

## Use

After enabling the plugin:

```text
/openstream doctor
/openstream doctor qwen3:latest
/openstream model deepseek-v3:671b
/openstream sample-config
```

Agents can also call the `openstream_doctor` tool.

## Config

Set config under `plugins.entries.openstream.config`:

```json5
{
  plugins: {
    entries: {
      openstream: {
        enabled: true,
        config: {
          promptGuidance: true,
          streamingMode: "enhanced",
          enableMegaContext: true,
          maxContextWindow: 262144,
          doctorDefaultProvider: "ollama",
        },
      },
    },
  },
}
```

## Why use it

Use OpenStream when you want a safer first step than patching provider internals directly.

It is especially useful when:

- a local open-source model emits markdown pseudo-tool calls
- you are evaluating long-context model families and want better heuristics
- you need a repeatable operator-facing doctor command before touching runtime code

## Relationship to the built-in Ollama provider

The built-in [Ollama provider](/providers/ollama) remains the actual provider/runtime path.

OpenStream complements it by adding:

- diagnostics
- cached system guidance
- model heuristics and config generation

If you need deeper provider-stream behavior changes, keep those changes narrow and evidence-backed.

## Related

- [Ollama](/providers/ollama)
- [Plugin SDK Overview](/plugins/sdk-overview)
- [Building Plugins](/plugins/building-plugins)
