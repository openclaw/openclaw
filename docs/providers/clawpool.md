---
summary: "$8/mo flat-rate Claude API access via pooled Claude Max capacity"
read_when:
  - You want cheap Claude access without per-token billing
  - You want Claude Opus/Sonnet at a fraction of API costs
  - You want flat-rate pricing instead of unpredictable API bills
title: "ClawPool"
---

# ClawPool

**ClawPool** is a community-run proxy that pools idle Claude Max subscription capacity and resells it as flat-rate API access. Instead of paying per token through the Anthropic API or $200/mo for your own Claude Max subscription, you get all Claude models (including Opus) for $8/mo flat.

## Why Use This?

| Approach          | Cost                      | Best For                              |
| ----------------- | ------------------------- | ------------------------------------- |
| Anthropic API     | $50–500+/mo (per token)   | Production apps, high volume          |
| Claude Max        | $200/mo                   | Heavy personal use, unlimited         |
| **ClawPool**      | **$8/mo flat**            | Personal use, development, OpenClaw   |

If you're spending $50+/mo on Claude API calls through OpenClaw, ClawPool can cut that to $8/mo with the same models and no per-token billing.

## How It Works

```
OpenClaw → ClawPool proxy → pooled Claude Max token → Anthropic
```

ClawPool consumer keys use the `sk-ant-oat-` prefix, which OpenClaw's pi-ai library automatically detects as OAuth tokens. The correct Claude Code headers are sent automatically — no special configuration needed beyond adding the provider.

## Setup

### 1. Get a ClawPool key

Sign up at [https://clawpool.ai](https://clawpool.ai) and subscribe. You'll get a consumer key like `sk-ant-oat-cpk-xxxxxx`.

### 2. Set your API key

```bash
export CLAWPOOL_API_KEY="sk-ant-oat-cpk-your_key_here"
```

Or add it to your shell profile (`~/.zshrc`, `~/.bashrc`).

### 3. Configure OpenClaw

Add ClawPool as a custom provider in `~/.openclaw/openclaw.json`:

```json5
{
  agents: {
    defaults: {
      model: { primary: "clawpool/claude-opus-4-6" },
    },
  },
  models: {
    mode: "merge",
    providers: {
      clawpool: {
        baseUrl: "https://proxy.clawpool.ai",
        apiKey: "${CLAWPOOL_API_KEY}",
        api: "anthropic-messages",
      },
    },
  },
}
```

### 4. Restart the gateway

```bash
openclaw gateway restart
```

### CLI Alternative

```bash
export CLAWPOOL_API_KEY="sk-ant-oat-cpk-your_key_here"
openclaw models set clawpool/claude-opus-4-6
```

## Available Models

ClawPool is a transparent proxy — any model available on the Anthropic API works. Use `clawpool/<model-id>` as the model reference (e.g. `clawpool/claude-opus-4-6`, `clawpool/claude-sonnet-4-5`).

## Troubleshooting

**"This credential is only authorized for use with Claude Code"**
- Your key must start with `sk-ant-oat-`. If it doesn't, contact ClawPool support for a new key.

**Requests not routing to ClawPool**
- Verify `baseUrl` is `https://proxy.clawpool.ai` (not `clawpool.ai`)
- Verify `api` is `anthropic-messages` (not `openai-completions`)
- Check that `CLAWPOOL_API_KEY` is set in your environment

**Model not found**
- Use model refs like `clawpool/claude-sonnet-4-5` (provider prefix + model ID)
- Model IDs must match what's listed in the `models` array in your config

## Notes

- This is a **community tool**, not officially supported by Anthropic or OpenClaw
- ClawPool pools capacity from Claude Max subscribers who donate idle usage
- All traffic goes through ClawPool's Cloudflare Worker proxy — no data is stored beyond usage tracking
- Streaming responses are fully supported

## Links

- **Website:** [https://clawpool.ai](https://clawpool.ai)
- **Issues:** [https://github.com/peter-jammable/clawpool-proxy-function/issues](https://github.com/peter-jammable/clawpool-proxy-function/issues)

## See Also

- [Anthropic provider](/providers/anthropic) - Native OpenClaw integration with Claude API keys
- [Claude Max API Proxy](/providers/claude-max-api-proxy) - Use your own Claude Max subscription as an API endpoint
