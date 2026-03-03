# Instagram Plugin

This OpenClaw extension uses `instagram-cli` / `instagram-cli-4llm` as the transport layer for
Instagram DMs and group threads.

## Minimal config

```json
{
  "channels": {
    "instagram": {
      "cliPath": "pnpm",
      "cliArgs": [
        "--dir",
        "/home/rylen/Documents/Projects/instagram-cli-4llm",
        "exec",
        "instagram-cli"
      ],
      "sessionUsername": "your_instagram_username",
      "dmPolicy": "pairing",
      "pollIntervalMs": 30000
    }
  }
}
```

## Notes

- `cliPath` can point to `instagram-cli` directly, or to `pnpm`/`npm` with `cliArgs`.
- `sessionUsername` is appended to the `llm` commands so the plugin uses the correct Instagram
  session.
- Polling checkpoints are written under the OpenClaw state dir in `instagram/<account>.json`.
- Direct targets can be `@username` or `thread:<id>`.
