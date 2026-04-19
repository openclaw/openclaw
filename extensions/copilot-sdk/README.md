# @openclaw/copilot-sdk

Experimental OpenClaw provider plugin that routes chat completions through the
[`@github/copilot`](https://www.npmjs.com/package/@github/copilot) CLI using
[`@github/copilot-sdk`](https://www.npmjs.com/package/@github/copilot-sdk).

The plugin:

- Spawns the `@github/copilot` CLI in the background (via the SDK)
- Exposes an OpenAI-compatible HTTP shim on `127.0.0.1` (default port `9527`)
- Registers a `copilot-sdk` provider that points at the shim
- Denies every permission request the CLI makes. The Copilot CLI is used as a
  pure LLM; OpenClaw continues to own tool dispatch through its own runtime.

This lets OpenClaw use the user's GitHub Copilot subscription for model calls
without any API key, through a GitHub-sanctioned path.

## Status

**Public preview.** The underlying `@github/copilot-sdk` package is itself in
public preview (`0.2.x`) and its wire protocol may change without notice. The
plugin pins an exact SDK version and is disabled by default. Pin both sides
explicitly in your distribution.

## Requirements

- Node 22+
- An active GitHub Copilot subscription
- `@github/copilot` CLI available. The SDK bundles a CLI by default; you can
  point at a specific binary via `plugins.entries.copilot-sdk.config.cliPath`.
- A one-time `copilot login` completed in a terminal so the SDK can reuse the
  logged-in user's credentials.

## Configuration

```yaml
plugins:
  entries:
    copilot-sdk:
      enabled: true
      config:
        # Loopback port for the local shim. 9527 by default.
        port: 9527
        # When true (default), requests that declare `tools` are rejected
        # with HTTP 400 rather than silently dropped.
        rejectToolRequests: true
        # Optional override for the @github/copilot CLI binary.
        # cliPath: /usr/local/bin/copilot
```

After enabling the plugin, run `openclaw onboard` and choose the
`copilot-sdk` setup option, or manually add the provider to your model
configuration. The plugin's auth wizard writes a placeholder token profile
and emits the config patch above.

## Limitations

- **No tool calling.** The Copilot CLI session runs with a deny-all
  permission handler, so tool calls emitted by the CLI are never executed.
  OpenClaw's own tool runtime continues to work; we simply don't forward
  OpenAI-format `tools` through the shim. Requests that declare tools are
  rejected with HTTP 400 (`tools_not_supported`) by default. Set
  `rejectToolRequests: false` to silently drop tools instead.
- **No per-token streaming.** The SDK emits whole assistant messages rather
  than token deltas. For `stream: true` requests the shim emits a single
  delta chunk followed by `[DONE]`.
- **No embeddings.** The CLI does not expose an embedding model.
- **No image uploads.** Image content parts in the OpenAI request are replaced
  with a placeholder note; attachments are not forwarded.

## How it works

```
OpenClaw agent
     │
     │  POST /v1/chat/completions
     ▼
127.0.0.1:9527 (shim server, in-process Node HTTP)
     │
     │  session.sendAndWait({ prompt })
     ▼
@github/copilot-sdk CopilotClient
     │
     │  JSON-RPC over stdio
     ▼
@github/copilot CLI (spawned child)
     │
     │  HTTPS to GitHub Copilot service
     ▼
GitHub Copilot
```

The shim server is a singleton per Node process and is started lazily on the
first catalog pass that resolves a Copilot SDK credential.

## Running the tests

```
pnpm --filter @openclaw/copilot-sdk test
```

All tests run with a mocked SDK; no network or real CLI is required.
