# OpenClaw Radius Provider

Connect OpenClaw to Earendil's Radius gateway with browser sign-in or an
organization API key. The plugin discovers account-visible models and supports
native Pi message streaming, reasoning, images on supported models, and tool calls.

```bash
openclaw plugins install @openclaw/radius-provider
openclaw models auth login --provider radius --method oauth --set-default
openclaw models list --provider radius --refresh
```

For API-key setups, use `--method api-key` or `RADIUS_API_KEY`.
Requests use the selected organization's credits and policies.

See [Radius setup and configuration](https://docs.openclaw.ai/providers/radius).
