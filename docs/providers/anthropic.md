---
summary: "Use Anthropic Claude via API keys or Claude CLI in OpenClaw"
read_when:
  - You want to use Anthropic models in OpenClaw
title: "Anthropic"
---

# Anthropic (Claude)

Anthropic builds the **Claude** model family and provides access via an API and
Claude CLI. In OpenClaw, Anthropic API keys and Claude CLI reuse are both
supported. Existing legacy Anthropic token profiles are still honored at
runtime if they are already configured.

<Warning>
Anthropic staff told us OpenClaw-style Claude CLI usage is allowed again, so
OpenClaw treats Claude CLI reuse and `claude -p` usage as sanctioned for this
integration unless Anthropic publishes a new policy.

For long-lived gateway hosts, Anthropic API keys are still the clearest and
most predictable production path. If you already use Claude CLI on the host,
OpenClaw can reuse that login directly.

Anthropic's current public docs:

- [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference)
- [Claude Agent SDK overview](https://platform.claude.com/docs/en/agent-sdk/overview)

- [Using Claude Code with your Pro or Max plan](https://support.claude.com/en/articles/11145838-using-claude-code-with-your-pro-or-max-plan)
- [Using Claude Code with your Team or Enterprise plan](https://support.anthropic.com/en/articles/11845131-using-claude-code-with-your-team-or-enterprise-plan/)

If you want the clearest billing path, use an Anthropic API key instead.
OpenClaw also supports other subscription-style options, including [OpenAI
Codex](/providers/openai), [Qwen Cloud Coding Plan](/providers/qwen),
[MiniMax Coding Plan](/providers/minimax), and [Z.AI / GLM Coding
Plan](/providers/glm).
</Warning>

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

### Anthropic config snippet

```json5
{
  env: { ANTHROPIC_API_KEY: "sk-ant-..." },
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## Thinking defaults (Claude 4.6)

- Anthropic Claude 4.6 models default to `adaptive` thinking in OpenClaw when no explicit thinking level is set.
- You can override per-message (`/think:<level>`) or in model params:
  `agents.defaults.models["anthropic/<model>"].params.thinking`.
- Related Anthropic docs:
  - [Adaptive thinking](https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking)
  - [Extended thinking](https://platform.claude.com/docs/en/build-with-claude/extended-thinking)

## Fast mode (Anthropic API)

OpenClaw's shared `/fast` toggle also supports direct public Anthropic traffic, including API-key and OAuth-authenticated requests sent to `api.anthropic.com`.

- `/fast on` maps to `service_tier: "auto"`
- `/fast off` maps to `service_tier: "standard_only"`
- Config default:

```json5
{
  agents: {
    defaults: {
      models: {
        "anthropic/claude-sonnet-4-6": {
          params: { fastMode: true },
        },
      },
    },
  },
}
```

Important limits:

- OpenClaw only injects Anthropic service tiers for direct `api.anthropic.com` requests. If you route `anthropic/*` through a proxy or gateway, `/fast` leaves `service_tier` untouched.
- Explicit Anthropic `serviceTier` or `service_tier` model params override the `/fast` default when both are set.
- Anthropic reports the effective tier on the response under `usage.service_tier`. On accounts without Priority Tier capacity, `service_tier: "auto"` may still resolve to `standard`.

## Prompt caching (Anthropic API)

OpenClaw supports Anthropic's prompt caching feature. This is **API-only**; legacy Anthropic token auth does not honor cache settings.

### Configuration

Use the `cacheRetention` parameter in your model config:

| Value   | Cache Duration | Description              |
| ------- | -------------- | ------------------------ |
| `none`  | No caching     | Disable prompt caching   |
| `short` | 5 minutes      | Default for API Key auth |
| `long`  | 1 hour         | Extended cache           |

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

This only activates when `params.context1m` is explicitly set to `true` for
that model.

Requirement: Anthropic must allow long-context usage on that credential.

Note: Anthropic currently rejects `context-1m-*` beta requests when using
legacy Anthropic token auth (`sk-ant-oat-*`). If you configure
`context1m: true` with that legacy auth mode, OpenClaw logs a warning and
falls back to the standard context window by skipping the context1m beta
header while keeping the required OAuth betas.

## Claude CLI backend

The bundled Anthropic `claude-cli` backend is supported in OpenClaw.

- Anthropic staff told us this usage is allowed again.
- OpenClaw therefore treats Claude CLI reuse and `claude -p` usage as
  sanctioned for this integration unless Anthropic publishes a new policy.
- Anthropic API keys remain the clearest production path for always-on gateway
  hosts and explicit server-side billing control.
- Setup and runtime details are in [/gateway/cli-backends](/gateway/cli-backends).

## Notes

- Anthropic's public Claude Code docs still document direct CLI usage such as
  `claude -p`, and Anthropic staff told us OpenClaw-style Claude CLI usage is
  allowed again. We are treating that guidance as settled unless Anthropic
  publishes a new policy change.
- Anthropic setup-token is available again in OpenClaw as a legacy/manual path.
- Auth details + reuse rules are in [/concepts/oauth](/concepts/oauth).

## Troubleshooting

**401 errors / token suddenly invalid**

- Legacy Anthropic token auth can expire or be revoked.
- For new setup, migrate to an Anthropic API key.

**No API key found for provider "anthropic"**

- Auth is **per agent**. New agents don’t inherit the main agent’s keys.
- Re-run onboarding for that agent, or configure an API key on the gateway
  host, then verify with `openclaw models status`.

**No credentials found for profile `anthropic:default`**

- Run `openclaw models status` to see which auth profile is active.
- Re-run onboarding, or configure an API key for that profile path.

**No available auth profile (all in cooldown/unavailable)**

- Check `openclaw models status --json` for `auth.unusableProfiles`.
- Anthropic rate-limit cooldowns can be model-scoped, so a sibling Anthropic
  model may still be usable even when the current one is cooling down.
- Add another Anthropic profile or wait for cooldown.

More: [/gateway/troubleshooting](/gateway/troubleshooting) and [/help/faq](/help/faq).
