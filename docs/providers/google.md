---
summary: "Use Google Gemini via API key or OAuth in OpenClaw"
read_when:
  - You want to use Google Gemini models in OpenClaw
  - You want Gemini CLI OAuth or Antigravity OAuth instead of an API key
title: "Google"
---

# Google (Gemini)

Google provides the **Gemini** model family. In OpenClaw you can authenticate
with an API key, the Gemini CLI OAuth flow, or Google Antigravity OAuth.

## Option A: Gemini API key

**Best for:** standard API access via Google AI Studio.
Create your API key in the [Google AI Studio](https://aistudio.google.com/).

### CLI setup

```bash
openclaw onboard --auth-choice gemini-api-key
# or non-interactive
openclaw onboard --gemini-api-key "$GEMINI_API_KEY"
```

### Config snippet

```json5
{
  env: { GEMINI_API_KEY: "..." },
  agents: { defaults: { model: { primary: "google/gemini-3-pro-preview" } } },
}
```

## Option B: Gemini CLI OAuth

**Best for:** using Google's OAuth flow (same credentials as the Gemini CLI tool), no API key required.

This uses the bundled `google-gemini-cli-auth` plugin. The plugin is auto-enabled
when you authenticate with it.

### CLI setup (Gemini CLI OAuth)

```bash
openclaw onboard --auth-choice google-gemini-cli
```

Or authenticate directly:

```bash
openclaw models auth login --provider google-gemini-cli --set-default
```

### Config snippet (Gemini CLI OAuth)

```json5
{
  agents: { defaults: { model: { primary: "google-gemini-cli/gemini-3-pro-preview" } } },
}
```

### Optional environment variables

If you need to target a specific Google Cloud project, set one of:

- `GOOGLE_CLOUD_PROJECT`
- `GOOGLE_CLOUD_PROJECT_ID`

If the Gemini CLI is not installed and you want to supply your own OAuth client
credentials, set:

- `GEMINI_CLI_OAUTH_CLIENT_ID` (or `OPENCLAW_GEMINI_OAUTH_CLIENT_ID`)
- `GEMINI_CLI_OAUTH_CLIENT_SECRET` (or `OPENCLAW_GEMINI_OAUTH_CLIENT_SECRET`)

## Option C: Google Antigravity OAuth

**Best for:** accessing Anthropic Claude models hosted on Google Cloud.

Antigravity serves **Claude models** (not Gemini) through Google's infrastructure.
This uses the bundled `google-antigravity-auth` plugin. The plugin is auto-enabled
when you authenticate with it.

### CLI setup (Antigravity OAuth)

```bash
openclaw onboard --auth-choice google-antigravity
```

Or authenticate directly:

```bash
openclaw models auth login --provider google-antigravity --set-default
```

### Config snippet (Antigravity OAuth)

```json5
{
  agents: { defaults: { model: { primary: "google-antigravity/claude-opus-4-6-thinking" } } },
}
```

## Notes

- Model refs always use `provider/model` (see [/concepts/models](/concepts/models)).
- Auth details and reuse rules are in [/concepts/oauth](/concepts/oauth).
- The Gemini CLI OAuth and Antigravity OAuth plugins are auto-enabled when their
  provider is referenced in your config. You can also enable them manually with
  `openclaw plugins enable google-gemini-cli-auth` or
  `openclaw plugins enable google-antigravity-auth`.
- Use `openclaw models list` and `openclaw models set <provider>/<model>` to switch models.
- See [/concepts/model-providers](/concepts/model-providers) for provider-wide rules.

## Troubleshooting

**OAuth fails to open a browser**

- On headless or remote machines the OAuth flow prints a URL to visit manually.
  Copy the URL and complete the flow in a local browser.

**Requests fail with a project error (Gemini CLI OAuth)**

- Set `GOOGLE_CLOUD_PROJECT` or `GOOGLE_CLOUD_PROJECT_ID` to the correct
  Google Cloud project ID.

**No available auth profile (all in cooldown/unavailable)**

- Check `openclaw models status --json` for `auth.unusableProfiles`.
- Add another Google profile or wait for cooldown.

More: [/gateway/troubleshooting](/gateway/troubleshooting) and [/help/faq](/help/faq).
