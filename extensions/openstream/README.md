# @openclaw/openstream

Bundled Ollama companion plugin for **OpenClaw**.

OpenStream gives OpenClaw operators and agents a stable install surface for:

- Ollama-oriented diagnostics
- long-context and reasoning-model heuristics
- cached system-prompt guidance for open-source tool-calling behavior
- generated sample config for plugin mode and runtime-bridge mode

It does **not** claim to replace the deepest raw stream/parser path yet. Instead,
it complements the built-in Ollama provider and narrows what still needs core
changes or stronger provider hooks later.

## What Agents Get

When enabled, the plugin provides:

- `/openstream` command
- `openstream_doctor` tool
- plugin-shipped `openstream` skill
- stable `before_prompt_build` system guidance for Ollama/open-source models

## Commands

```text
/openstream doctor [model]
/openstream model <modelId>
/openstream sample-config
/openstream help
```

## Plugin Config

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

## Notes

- OpenStream is a **companion plugin**, not a replacement provider.
- Use it when you want stronger diagnosis and installable guidance around Ollama.
- Keep deeper provider-stream experimentation on a narrower core or provider-hook path.
