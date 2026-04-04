---
summary: "Use Anthropic Claude via API keys, setup-token, or Claude CLI in OpenClaw"
read_when:
  - You want to use Anthropic models in OpenClaw
  - You want setup-token instead of API keys
  - You want to reuse Claude CLI subscription auth on the gateway host
title: "Anthropic"
---

# Anthropic (Claude)

Anthropic builds the **Claude** model family and provides access via an API.
In OpenClaw you can authenticate with an API key or a **setup-token**.

<Warning>
Anthropic changed third-party harness billing on **April 4, 2026 at 12:00 PM
PT / 8:00 PM BST**. Anthropic says Claude subscription limits no longer cover
OpenClaw or other third-party harnesses. You can still use Anthropic
subscription auth in OpenClaw, but Anthropic now requires **Extra Usage**
(pay-as-you-go, billed separately from the subscription) for that traffic.

If you want a clearer billing path, use an Anthropic API key instead. OpenClaw
also supports other subscription-style options, including [OpenAI
Codex](/providers/openai), [Alibaba Cloud Model Studio Coding
Plan](/providers/qwen_modelstudio), [MiniMax Coding Plan](/providers/minimax),
and [Z.AI / GLM Coding Plan](/providers/glm).
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

### Claude CLI config snippet

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

This only activates when `params.context1m` is explicitly set to `true` for
that model.

Requirement: Anthropic must allow long-context usage on that credential
(typically API key billing, or a subscription account with Extra Usage
enabled). Otherwise Anthropic returns:
`HTTP 429: rate_limit_error: Extra usage is required for long context requests`.

Note: Anthropic currently rejects `context-1m-*` beta requests when using
subscription setup-tokens (`sk-ant-oat-*`). If you configure `context1m: true`
with subscription auth, OpenClaw logs a warning and falls back to the standard
context window by skipping the context1m beta header while keeping the required
OAuth betas.

## Option B: Claude CLI as the message provider

**Best for:** a single-user gateway host that already has Claude CLI installed
and signed in with a Claude subscription.

Billing note: when Claude CLI is used through OpenClaw, Anthropic now treats
that traffic as third-party harness usage. As of **April 4, 2026 at 12:00 PM
PT / 8:00 PM BST**, Anthropic requires **Extra Usage** instead of included
Claude subscription limits for this path.

This path uses the local `claude` binary for model inference instead of calling
the Anthropic API directly. OpenClaw treats it as a **CLI backend provider**
with model refs like:

- `claude-cli/claude-sonnet-4-6`
- `claude-cli/claude-opus-4-6`

How it works:

1. OpenClaw launches `claude -p --output-format json ...` on the **gateway
   host**.
2. The first turn sends `--session-id <uuid>`.
3. Follow-up turns reuse the stored Claude session via `--resume <sessionId>`.
4. Your chat messages still go through the normal OpenClaw message pipeline, but
   the actual model reply is produced by Claude CLI.

### Requirements

- Claude CLI installed on the gateway host and available on PATH, or configured
  with an absolute command path.
- Claude CLI already authenticated on that same host:

```bash
claude auth status
```

- OpenClaw auto-loads the bundled Anthropic plugin at gateway startup when your
  config explicitly references `claude-cli/...` or `claude-cli` backend config.

### Config snippet

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "claude-cli/claude-sonnet-4-6",
      },
      models: {
        "claude-cli/claude-sonnet-4-6": {},
      },
      sandbox: { mode: "off" },
    },
  },
}
```

If the `claude` binary is not on the gateway host PATH:

```json5
{
  agents: {
    defaults: {
      cliBackends: {
        "claude-cli": {
          command: "/opt/homebrew/bin/claude",
        },
      },
    },
  },
}
```

### What you get

- Claude subscription auth reused from the local CLI
- Normal OpenClaw message/session routing
- Claude CLI session continuity across turns

### Migrate from Anthropic auth to Claude CLI

If you currently use `anthropic/...` with a setup-token or API key and want to
switch the same gateway host to Claude CLI, OpenClaw supports that as a normal
provider-auth migration path.

Prerequisites:

- Claude CLI installed on the **same gateway host** that runs OpenClaw
- Claude CLI already signed in there: `claude auth login`

Then run:

```bash
openclaw models auth login --provider anthropic --method cli --set-default
```

Or in onboarding:

```bash
openclaw onboard --auth-choice anthropic-cli
```

Interactive `openclaw onboard` and `openclaw configure` now prefer **Anthropic
Claude CLI** first and **Anthropic API key** second. The setup-token flow
remains supported through manual auth commands, but is not shown in the
assistant picker.

What this does:

- verifies Claude CLI is already signed in on the gateway host
- switches the default model to `claude-cli/...`
- rewrites Anthropic default-model fallbacks like `anthropic/claude-opus-4-6`
  to `claude-cli/claude-opus-4-6`
- adds matching `claude-cli/...` entries to `agents.defaults.models`

Quick verification:

```bash
openclaw models status
```

You should see the resolved primary model under `claude-cli/...`.

What it does **not** do:

- delete your existing Anthropic auth profiles
- remove every old `anthropic/...` config reference outside the main default
  model/allowlist path

That makes rollback simple: change the default model back to `anthropic/...` if
you need to.

### Important limits

- This is **not** the Anthropic API provider. It is the local CLI runtime.
- Tools are disabled on the OpenClaw side for CLI backend runs.
- Text in, text out. No OpenClaw streaming handoff.
- Best fit for a personal gateway host, not shared multi-user billing setups.

More details: [/gateway/cli-backends](/gateway/cli-backends)

## Option C: Claude setup-token (manual)

**Best for:** using your Claude subscription with Anthropic **Extra Usage**
enabled, or while transitioning to API-key billing.

### Where to get a setup-token

Setup-tokens are created by the **Claude Code CLI**, not the Anthropic Console. You can run this on **any machine**:

```bash
claude setup-token
```

Then either run it on the gateway host:

```bash
openclaw models auth setup-token --provider anthropic
```

Or if you generated the token on a different machine, paste it:

```bash
openclaw models auth paste-token --provider anthropic
```

### Config snippet (setup-token)

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## Notes

- Generate the setup-token with `claude setup-token` and paste it, or run `openclaw models auth setup-token` on the gateway host.
- Anthropic says that starting **April 4, 2026 at 12:00 PM PT / 8:00 PM BST**,
  OpenClaw usage with Claude subscription auth requires **Extra Usage**
  (pay-as-you-go billed separately from the subscription).
- If you see “OAuth token refresh failed …” on a Claude subscription, re-auth with a setup-token. See [/gateway/troubleshooting](/gateway/troubleshooting).
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
