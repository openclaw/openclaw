# Tenki Cloud Sandbox

OpenClaw sandbox backend that runs agent tool execution in remote [Tenki Cloud](https://tenki.cloud) microVM sessions via the [`@tenkicloud/sandbox`](https://www.npmjs.com/package/@tenkicloud/sandbox) TypeScript SDK.

One Tenki session is created per sandbox scope (found-or-created by a runtime tag; paused sessions are resumed). The local workspace is mirrored into the session, shell and filesystem-bridge commands run over the SDK exec surface, and interactive exec is spawned through the local `tenki` CLI.

## Usage

```jsonc
{
  "plugins": {
    "entries": {
      "tenki": {
        "enabled": true,
        "config": {
          "image": "ubuntu-24",
          "memoryMb": 4096,
        },
      },
    },
  },
  "agents": {
    "defaults": {
      "sandbox": {
        "mode": "all",
        "backend": "tenki",
      },
    },
  },
}
```

Authentication uses `TENKI_AUTH_TOKEN` / `TENKI_API_KEY` from the environment (preferred), or the `authToken` plugin config value. Interactive exec additionally requires the `tenki` CLI on the gateway host (`cliCommand` config).

## Known limitations (draft)

- `usePty` degrades to non-PTY exec (should route through `tenki sandbox ssh`).
- The skills workspace is uploaded once at runtime bootstrap, not refreshed per exec.
- Workspace upload buffers a tarball in memory; large workspaces should stream.
