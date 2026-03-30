# QNAIGC API (OpenClaw plugin)

Provider plugin for QNAIGC models served through an Anthropic-compatible endpoint.

## Enable

Bundled plugins are disabled by default. Enable this one:

```bash
openclaw plugins enable qnaigc-api
```

Restart the Gateway after enabling.

## Authenticate

```bash
openclaw models auth login --provider qnaigc-api --set-default
```

## Notes

- Set `QNAIGC_API_KEY` before using the provider.
- The provider uses `https://anthropic.qnaigc.com`.
