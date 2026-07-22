# Tenki Cloud Sandbox

OpenClaw sandbox backend that runs agent tool execution in remote [Tenki Cloud](https://tenki.cloud) microVM sessions via the [`@tenkicloud/sandbox`](https://www.npmjs.com/package/@tenkicloud/sandbox) TypeScript SDK.

One Tenki session is created per sandbox scope (found-or-created by a runtime tag; paused sessions are resumed). The local workspace is mirrored into the session, shell and filesystem-bridge commands run over the SDK exec surface, and interactive exec runs over plain `ssh` through an in-process loopback forwarder backed by the SDK's gateway SSH stream.

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

Authentication uses `TENKI_AUTH_TOKEN` / `TENKI_API_KEY` from the environment (preferred), or the `authToken` plugin config value.

Interactive exec spawns plain `ssh` against a loopback forwarder whose upstream is the SDK's gateway SSH stream — no tenki CLI required anywhere, and `usePty` maps to real PTY allocation (`ssh -tt`). The gateway stream terminates at Tenki's edge SSH gateway, which only accepts certificate auth: a dedicated ed25519 keypair is generated once under the OpenClaw state dir, and a short-lived per-session user certificate is minted through the SDK and re-minted automatically near expiry.

## Known limitations

- The skills workspace is uploaded once at runtime bootstrap, not refreshed per exec.
- Workspace upload buffers a tarball in memory; large workspaces should stream.
- The SSH forwarder listener lives for the gateway process lifetime (one per sandbox scope; backend handles have no dispose hook).
