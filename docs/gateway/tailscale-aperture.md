---
summary: "Configure OpenClaw to use Tailscale Aperture as an AI gateway proxy"
read_when:
  - Using Tailscale Aperture with OpenClaw
  - Proxying AI requests through your tailnet
  - Setting up custom providers with Aperture
title: "Tailscale Aperture Integration"
---

# Tailscale Aperture Integration

Tailscale Aperture is an AI gateway that runs on your tailnet and proxies requests to AI providers (OpenRouter, OpenAI, Anthropic, etc.). This guide shows how to configure OpenClaw to use Aperture as a custom provider.

## Overview

**What is Tailscale Aperture?**

Tailscale Aperture provides:

- **Privacy**: AI requests stay within your tailnet until they reach the provider
- **Centralized auth**: One place to manage API keys for multiple providers
- **Request logging**: See all AI requests in one place
- **Rate limiting**: Control API usage across your tailnet

**How it works with OpenClaw:**

```
OpenClaw → Tailscale (tailnet) → Aperture → AI Provider (OpenRouter/OpenAI/etc)
```

## Prerequisites

1. **Tailscale** installed and logged in
2. **Tailscale Aperture** running on your tailnet
3. **Aperture endpoint URL** (e.g., `http://aperture-host:8080`)
4. **Provider configured in Aperture** (OpenRouter, OpenAI, etc.)

## Configuration

### Step 1: Get Aperture Endpoint

Find your Aperture host's tailnet address:

```bash
tailscale status
```

Look for the machine running Aperture. Note its IP or MagicDNS name.

**Example:**

- MagicDNS: `http://aperture.tail123abc.ts.net:8080`
- Tailnet IP: `http://100.64.0.5:8080`

### Step 2: Configure OpenClaw Custom Provider

Add Aperture as a custom provider in `~/.openclaw/openclaw.json`:

```json
{
  "models": {
    "providers": {
      "aperture": {
        "type": "openai-compatible",
        "baseUrl": "http://aperture.tail123abc.ts.net:8080/v1",
        "apiKey": "dummy-key-not-used"
      }
    },
    "catalog": {
      "aperture/openrouter/anthropic/claude-opus-4-5": {
        "providerId": "aperture",
        "providerModelId": "anthropic/claude-opus-4-5",
        "contextWindow": 200000,
        "maxTokens": 4096
      }
    }
  },
  "agents": {
    "defaults": {
      "model": {
        "primary": "aperture/openrouter/anthropic/claude-opus-4-5"
      }
    }
  }
}
```

### Step 3: Define Model Metadata

**Critical:** Aperture may not return model metadata (context window, max tokens), so OpenClaw defaults to 4096 tokens, which breaks long-context models.

**You must explicitly set:**

- `contextWindow`: Maximum input tokens (e.g., 200000 for Claude Opus)
- `maxTokens`: Maximum output tokens (e.g., 4096 for most models)

**Common model specs:**

| Model             | contextWindow | maxTokens |
| ----------------- | ------------- | --------- |
| Claude Opus 4.5   | 200000        | 4096      |
| Claude Sonnet 4.5 | 200000        | 8192      |
| GPT-4 Turbo       | 128000        | 4096      |
| GPT-4o            | 128000        | 16384     |

### Step 4: Test Configuration

```bash
# Verify OpenClaw can see the model
openclaw models list | grep aperture

# Test a simple request
openclaw agent --message "Hello" --thinking low
```

## Troubleshooting

### Error: Context window too small

**Symptom:**

```
Error: Context exceeds model limit (4096 tokens)
```

**Cause:** OpenClaw defaulted to 4096 tokens because Aperture didn't provide model metadata.

**Fix:**

Add explicit `contextWindow` and `maxTokens` to your model catalog entry (see Step 3 above).

### Error: Connection refused

**Symptom:**

```
Error: connect ECONNREFUSED 100.64.0.5:8080
```

**Cause:** Can't reach Aperture on the tailnet.

**Check:**

```bash
# Verify Tailscale is connected
tailscale status

# Test Aperture endpoint directly
curl http://aperture.tail123abc.ts.net:8080/v1/models

# Check Aperture is running
ssh aperture-host "ps aux | grep aperture"
```

### Error messages not shown in CLI/UI

**Symptom:** CLI appears stuck, web dashboard chat doesn't show errors.

**Cause:** Some provider errors are only logged to Gateway logs.

**Check logs:**

```bash
# View real-time logs
openclaw logs --follow

# Or check dashboard logs
openclaw dashboard
# → Navigate to Logs tab
```

**Look for:**

- `Model not found` errors
- `Context window` errors
- `Provider connection` errors

### API key issues

**Symptom:**

```
Error: Unauthorized (401)
```

**Notes:**

- Aperture handles API keys, not OpenClaw
- The `apiKey` in OpenClaw config is unused (Aperture-compatible providers may require a placeholder value like `"dummy-key-not-used"`)
- Configure actual API keys in **Aperture**, not OpenClaw

**Check Aperture configuration:**

```bash
# SSH to Aperture host
ssh aperture-host

# Check Aperture config
cat ~/.aperture/config.yaml
# Verify API keys are set for your provider
```

### Model ID format

**OpenRouter via Aperture:**

```
aperture/openrouter/anthropic/claude-opus-4-5
```

Format: `<providerId>/<aperture-backend>/<model-path>`

**OpenAI via Aperture:**

```
aperture/openai/gpt-4-turbo
```

Format: `<providerId>/<aperture-backend>/<model-name>`

## Advanced Configuration

### Multiple providers through Aperture

You can configure multiple backends in one Aperture instance:

```json
{
  "models": {
    "providers": {
      "aperture": {
        "type": "openai-compatible",
        "baseUrl": "http://aperture.tail123abc.ts.net:8080/v1",
        "apiKey": "dummy"
      }
    },
    "catalog": {
      "aperture/openrouter/anthropic/claude-opus-4-5": {
        "providerId": "aperture",
        "providerModelId": "openrouter/anthropic/claude-opus-4-5",
        "contextWindow": 200000,
        "maxTokens": 4096
      },
      "aperture/openai/gpt-4-turbo": {
        "providerId": "aperture",
        "providerModelId": "openai/gpt-4-turbo",
        "contextWindow": 128000,
        "maxTokens": 4096
      }
    }
  }
}
```

### Fallback to direct provider

Configure direct provider access as a fallback if Aperture is down:

```json
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "aperture/openrouter/anthropic/claude-opus-4-5",
        "fallback": "anthropic/claude-opus-4-5-20251101-v1:0"
      }
    }
  }
}
```

This requires both Aperture **and** direct Anthropic API key to be configured.

### Custom timeout for Aperture

If Aperture is slow to respond (e.g., cold start), increase timeout:

```json
{
  "models": {
    "providers": {
      "aperture": {
        "type": "openai-compatible",
        "baseUrl": "http://aperture.tail123abc.ts.net:8080/v1",
        "apiKey": "dummy",
        "timeout": 120000
      }
    }
  }
}
```

Timeout is in milliseconds (120000 = 2 minutes).

## Validation Checklist

Before using Aperture in production:

- [ ] Aperture is reachable from OpenClaw host (`curl` test)
- [ ] Model metadata (`contextWindow`, `maxTokens`) explicitly set
- [ ] Test message succeeds: `openclaw agent --message "test"`
- [ ] Check logs for errors: `openclaw logs --follow`
- [ ] Verify tokens are counted correctly (not truncated at 4096)
- [ ] Configure fallback provider for redundancy

## Security Considerations

**Tailnet-only access:**

- Aperture should **only** be exposed on your tailnet, not the public internet
- Use Tailscale ACLs to restrict which machines can reach Aperture
- OpenClaw doesn't need to authenticate to Aperture (tailnet provides identity)

**API key storage:**

- Store actual provider API keys in **Aperture** config, not OpenClaw
- OpenClaw's `apiKey` field is a placeholder when using Aperture
- Aperture handles authentication to downstream providers

**Logging:**

- Aperture logs all requests — be mindful of sensitive data in prompts
- Consider retention policies for Aperture logs
- OpenClaw also logs requests locally (check `~/.openclaw/logs/`)

## Related Documentation

- [Tailscale Overview](/gateway/tailscale) - Tailscale Serve/Funnel for Gateway dashboard
- [Model Providers](/providers) - General provider configuration
- [Model Configuration](/concepts/models) - Model catalog and provider setup
- [Troubleshooting](/gateway/troubleshooting) - General Gateway troubleshooting

## External Resources

- Tailscale Aperture: <https://tailscale.com/blog/aperture>
- OpenRouter Documentation: <https://openrouter.ai/docs>
- OpenAI-Compatible API Spec: <https://platform.openai.com/docs/api-reference>

## Known Issues

**Issue #20531**: Aperture doesn't return model metadata, causing OpenClaw to default to 4096 token context window.

**Workaround**: Always explicitly set `contextWindow` and `maxTokens` in model catalog.

**Future improvement**: OpenClaw could query Aperture's model list endpoint to auto-detect specs, but this is not currently implemented.

---

**Need help?** Ask in [Discord #setup-help](https://discord.gg/qkhbAGHRBT) or open a [GitHub Discussion](https://github.com/openclaw/openclaw/discussions).
