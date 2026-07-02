---
summary: "Pioneer setup with live model discovery"
title: "Pioneer"
read_when:
  - You want to use Pioneer with OpenClaw
  - You need live Pioneer model discovery or the API key env var
---

[Pioneer](https://pioneer.ai) exposes an OpenAI-compatible API.

| Property | Value                       |
| -------- | --------------------------- |
| Provider | `pioneer`                   |
| Auth     | `PIONEER_API_KEY`           |
| API      | OpenAI-compatible           |
| Base URL | `https://api.pioneer.ai/v1` |

## Install plugin

Install the official plugin, then restart Gateway:

```bash
openclaw plugins install @openclaw/pioneer-provider
openclaw gateway restart
```

## Getting started

<Steps>
  <Step title="Set your API key">
    ```bash
    export PIONEER_API_KEY="YOUR_API_KEY_HERE"
    ```
  </Step>
  <Step title="Run onboarding">
    ```bash
    openclaw onboard --auth-choice pioneer-api-key
    ```

    This prompts for your API key and sets `pioneer/auto` as the
    default model, which routes each request to the best available Pioneer model automatically.

  </Step>
  <Step title="Verify live models">
    ```bash
    openclaw models list --provider pioneer
    ```

    OpenClaw calls Pioneer's live `/models` endpoint when `PIONEER_API_KEY` is
    available. Live-only model ids such as `pioneer/sakana/fugu-ultra` appear
    even when they are not present in OpenClaw's static bootstrap catalog.

  </Step>
</Steps>

<Warning>
If Gateway runs as a daemon (launchd/systemd), make sure `PIONEER_API_KEY` is
available to that process, for example through `~/.openclaw/.env` or
`env.shellEnv`.
</Warning>

## Catalog behavior

Pioneer uses runtime model discovery. The plugin keeps a minimal static
bootstrap model so setup and fallback paths have a default, but normal model
listing and selection are based on Pioneer's live `/v1/models` response.

When a live model id is not in the bootstrap metadata, OpenClaw still lists it
with conservative defaults: text input, 128K context, 16K max output, no
reasoning flag, and zero cost metadata unless Pioneer returns richer metadata
in the live row.

## Config example

```json5
{
  env: { PIONEER_API_KEY: "YOUR_API_KEY_HERE" }, // pragma: allowlist secret
  agents: { defaults: { model: { primary: "pioneer/auto" } } },
}
```
