---
summary: "Use a personal Claude subscription (Pro or Max) with OpenClaw via Claude Code system-keychain auth"
read_when:
  - You have a Claude Pro or Max subscription and want to use it in OpenClaw
  - You want to set up claude-personal provider auth
  - You are debugging keychain auth or token expiry issues
title: "Claude Personal (Subscription)"
---

# Claude Personal (Subscription)

The `claude-personal` provider lets you use a personal Claude subscription (Pro or Max) in OpenClaw via the Claude Agent SDK and Claude Code's system-keychain credentials.

<Warning>
**Anthropic policy notice:** Using the Claude Agent SDK for 24/7 autonomous bots
is prohibited by Anthropic. Using a personal subscription for business purposes
or for people other than the subscriber violates Anthropic Terms of Service.
You must decide for yourself whether your use complies with Anthropic's current terms.
API keys remain the clearer and safer path for production or business use.
</Warning>

## How it works

OpenClaw reads credentials from the Claude Code system keychain (the same credentials
`claude` CLI uses). No separate API key is required — your active Pro or Max
subscription is the auth.

Because this uses Claude Code's session state rather than a standard API token, there
is **no automatic token refresh**. If the system-keychain credentials expire or
become invalid (for example after a browser session ends or you sign out of Claude),
OpenClaw will fail over to Pi runtime for that turn. You must re-authenticate with
`claude` to restore the keychain credentials.

## Setup

### CLI (recommended)

```bash
openclaw models auth setup-claude-personal
```

This prints the Anthropic policy notice, asks for acknowledgment, then creates a
synthetic profile (`claude-personal:system-keychain`) that OpenClaw uses for
cooldown tracking and failover.

### Interactive onboarding

```bash
openclaw models auth add
# choose: Configure Claude Code w/Keychain
```

### Verify

```bash
openclaw models status
openclaw channels status --probe
```

## Configuration

```json5
{
  agents: {
    defaults: {
      model: { primary: "claude-personal/claude-opus-4-6" },
      claudeSdk: {
        // Optional: override the thinking level for SDK turns.
        // Omit to let the model's default apply.
        thinkingDefault: "medium",
      },
    },
  },
}
```

Full `claudeSdk` options: [Configuration reference](/gateway/configuration-reference#agentsdefaultsclaudesdk).

## Thinking

Claude 4.6 models (`claude-opus-4-6`, `claude-sonnet-4-6`) default to adaptive
thinking when no explicit level is set. You can override per-message (`/think:<level>`)
or via config:

- `agents.defaults.claudeSdk.thinkingDefault` — SDK-specific default
- `agents.defaults.models["claude-personal/<model>"].params.thinking` — per-model

## Auth failover

If keychain auth is unavailable (expired, signed out, all profiles cooling down),
OpenClaw retries the turn on Pi runtime and continues normal model/provider
failover from there. See [Model failover](/concepts/model-failover#claude-code-keychain-providers).

## No token refresh

The `claude-personal` provider uses a `token` credential type with no refresh
mechanism. If credentials become stale, OpenClaw cannot renew them automatically.
Re-run `claude` to sign in and restore system-keychain auth, then retry.

## See also

- [Claude SDK Runtime](/concepts/claude-sdk-runtime)
- [Model failover](/concepts/model-failover)
- [Configuration reference](/gateway/configuration-reference#agentsdefaultsclaudesdk)
