---
summary: "Use Anthropic Claude via API keys or setup-token in OpenClaw"
read_when:
  - You want to use Anthropic models in OpenClaw
  - You want setup-token instead of API keys
title: "Anthropic"
---

# Anthropic (Claude)

Anthropic builds the **Claude** model family and provides access via an API.
In OpenClaw you can authenticate with an API key or a **setup-token**.

## Option A: Anthropic API key

**Best for:** standard API access and usage-based billing.
Create your API key in the Anthropic Console.

### CLI setup

```bash
openclaw onboard
# choose: Anthropic API key

# or non-interactive
openclaw onboard --anthropic-api-key "$ANTHROPIC_API_KEY"
```

### Config snippet

```json5
{
  env: { ANTHROPIC_API_KEY: "sk-ant-..." },
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## Prompt caching (Anthropic API)

OpenClaw supports Anthropic's prompt caching feature. This is **API-only**; subscription auth does not honor cache settings.

### Configuration

Use the `cacheRetention` parameter in your model config:

| Value   | Cache Duration | Description                         |
| ------- | -------------- | ----------------------------------- |
| `none`  | No caching     | Disable prompt caching              |
| `short` | 5 minutes      | Default for API Key auth            |
| `long`  | 1 hour         | Extended cache (requires beta flag) |

```json5
{
  agents: {
    defaults: {
      models: {
        "anthropic/claude-opus-4-6": {
          params: { cacheRetention: "long" },
        },
      },
    },
  },
}
```

### Defaults

When using Anthropic API Key authentication, OpenClaw automatically applies `cacheRetention: "short"` (5-minute cache) for all Anthropic models. You can override this by explicitly setting `cacheRetention` in your config.

### Per-agent cacheRetention overrides

Use model-level params as your baseline, then override specific agents via `agents.list[].params`.

```json5
{
  agents: {
    defaults: {
      model: { primary: "anthropic/claude-opus-4-6" },
      models: {
        "anthropic/claude-opus-4-6": {
          params: { cacheRetention: "long" }, // baseline for most agents
        },
      },
    },
    list: [
      { id: "research", default: true },
      { id: "alerts", params: { cacheRetention: "none" } }, // override for this agent only
    ],
  },
}
```

Config merge order for cache-related params:

1. `agents.defaults.models["provider/model"].params`
2. `agents.list[].params` (matching `id`, overrides by key)

This lets one agent keep a long-lived cache while another agent on the same model disables caching to avoid write costs on bursty/low-reuse traffic.

### Bedrock Claude notes

- Anthropic Claude models on Bedrock (`amazon-bedrock/*anthropic.claude*`) accept `cacheRetention` pass-through when configured.
- Non-Anthropic Bedrock models are forced to `cacheRetention: "none"` at runtime.
- Anthropic API-key smart defaults also seed `cacheRetention: "short"` for Claude-on-Bedrock model refs when no explicit value is set.

### Legacy parameter

The older `cacheControlTtl` parameter is still supported for backwards compatibility:

- `"5m"` maps to `short`
- `"1h"` maps to `long`

We recommend migrating to the new `cacheRetention` parameter.

OpenClaw includes the `extended-cache-ttl-2025-04-11` beta flag for Anthropic API
requests; keep it if you override provider headers (see [/gateway/configuration](/gateway/configuration)).

## 1M context window (Anthropic beta)

Anthropic's 1M context window is beta-gated. In OpenClaw, enable it per model
with `params.context1m: true` for supported Opus/Sonnet models.

```json5
{
  agents: {
    defaults: {
      models: {
        "anthropic/claude-opus-4-6": {
          params: { context1m: true },
        },
      },
    },
  },
}
```

OpenClaw maps this to `anthropic-beta: context-1m-2025-08-07` on Anthropic
requests.

Note: Anthropic currently rejects `context-1m-*` beta requests when using
OAuth/subscription tokens (`sk-ant-oat-*`). OpenClaw automatically skips the
context1m beta header for OAuth auth and keeps the required OAuth betas.

## Option B: Claude setup-token

**Best for:** using your Claude subscription.

### Where to get a setup-token

Setup-tokens are created by the **Claude Code CLI**, not the Anthropic Console. You can run this on **any machine**:

```bash
claude setup-token
```

Paste the token into OpenClaw (wizard: **Anthropic token (paste setup-token)**), or run it on the gateway host:

```bash
openclaw models auth setup-token --provider anthropic
```

If you generated the token on a different machine, paste it:

```bash
openclaw models auth paste-token --provider anthropic
```

### CLI setup (setup-token)

```bash
# Paste a setup-token during onboarding
openclaw onboard --auth-choice setup-token
```

### Config snippet (setup-token)

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## Notes

- Generate the setup-token with `claude setup-token` and paste it, or run `openclaw models auth setup-token` on the gateway host.
- If you see “OAuth token refresh failed …” on a Claude subscription, re-auth with a setup-token. See [/gateway/troubleshooting#oauth-token-refresh-failed-anthropic-claude-subscription](/gateway/troubleshooting#oauth-token-refresh-failed-anthropic-claude-subscription).
- Auth details + reuse rules are in [/concepts/oauth](/concepts/oauth).

## Troubleshooting

**401 errors / token suddenly invalid**

- Claude subscription auth can expire or be revoked. Re-run `claude setup-token`
  and paste it into the **gateway host**.
- If the Claude CLI login lives on a different machine, use
  `openclaw models auth paste-token --provider anthropic` on the gateway host.

**No API key found for provider "anthropic"**

- Auth is **per agent**. New agents don’t inherit the main agent’s keys.
- Re-run onboarding for that agent, or paste a setup-token / API key on the
  gateway host, then verify with `openclaw models status`.

**No credentials found for profile `anthropic:default`**

- Run `openclaw models status` to see which auth profile is active.
- Re-run onboarding, or paste a setup-token / API key for that profile.

**No available auth profile (all in cooldown/unavailable)**

- Check `openclaw models status --json` for `auth.unusableProfiles`.
- Add another Anthropic profile or wait for cooldown.

More: [/gateway/troubleshooting](/gateway/troubleshooting) and [/help/faq](/help/faq).
