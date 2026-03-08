# Crust Proxy (OpenClaw plugin)

Provider plugin for routing model traffic through a local **Crust** gateway.

The OpenAI-compatible flow ships with a small starter set of models, including
`gpt-5.2`, `claude-sonnet-4.5`, `gemini-3-flash`, and `kimi-k2.5`. You can also
enter any other model IDs that your Crust gateway exposes.

## Enable

Bundled plugins are disabled by default. Enable this one:

```bash
openclaw plugins enable crust-proxy
```

Restart the Gateway after enabling.

## Authenticate

OpenAI-compatible routing:

```bash
openclaw models auth login --provider crust-openai --set-default
```

Anthropic Messages routing:

```bash
openclaw models auth login --provider crust-anthropic --set-default
```

## Requirements

- Crust must be running locally.
- The default gateway URL is `http://localhost:9090`.
- This plugin is intended for API-key based routing through Crust.

## Notes

- If you already manage a custom provider in `openclaw.json`, pointing that provider's `baseUrl` at Crust is still a valid alternative.
- OpenClaw's official OpenAI and Anthropic OAuth flows may bypass custom `baseUrl` handling, so they are not the primary integration path for this plugin.
