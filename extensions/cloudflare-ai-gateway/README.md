# OpenClaw Cloudflare AI Gateway Provider

Official OpenClaw provider plugin for Cloudflare AI Gateway.

Development checkouts also support Clef decisions through the separate
`cloudflare-workers-ai` provider. It requires a Cloudflare Workers AI token,
not the Anthropic key used by the Gateway chat provider. Clef setup does not
change chat defaults. This requires the Decision V2 host contract and is not
available in the previously published plugin.

Install from OpenClaw:

```bash
openclaw plugins install @openclaw/cloudflare-ai-gateway-provider
openclaw gateway restart
```

See <https://docs.openclaw.ai/providers/cloudflare-ai-gateway> for setup and configuration.
