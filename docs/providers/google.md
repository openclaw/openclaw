---
summary: "Use Google Gemini, Vertex AI, and Gemini CLI OAuth in OpenClaw"
read_when:
  - You want to use Gemini models in OpenClaw
  - You need setup guidance for Google API key, Vertex AI, or Gemini CLI OAuth
title: "Google / Gemini"
---

# Google / Gemini

OpenClaw supports these Google provider IDs:

| Provider ID         | Auth path                               | Typical use                          |
| ------------------- | --------------------------------------- | ------------------------------------ |
| `google`            | Gemini API key                          | Standard Gemini API usage            |
| `google-vertex`     | Google ADC (`gcloud` / service account) | GCP org-managed setup                |
| `google-gemini-cli` | OAuth via bundled plugin                | Gemini CLI / Cloud Code Assist OAuth |

## `google` (Gemini API key)

This is the default Google path for most users.

### CLI setup

```bash
openclaw onboard --auth-choice gemini-api-key
# or non-interactive
openclaw onboard --gemini-api-key "$GEMINI_API_KEY"
```

### Config snippet

```json5
{
  env: { GEMINI_API_KEY: "AIza..." },
  agents: { defaults: { model: { primary: "google/gemini-3.1-pro-preview" } } },
}
```

### API key rotation

On execution paths that enable API-key rotation (for example media understanding
and memory embeddings), OpenClaw builds a deduplicated key candidate list from:

1. The currently selected provider credential (if any)
2. `OPENCLAW_LIVE_GEMINI_KEY`
3. `GEMINI_API_KEYS` (comma/semicolon list)
4. `GEMINI_API_KEY`
5. `GEMINI_API_KEY_1`, `GEMINI_API_KEY_2`, ...
6. `GOOGLE_API_KEY` (fallback)

Retries rotate only on rate-limit style failures (`429`, quota/resource exhausted).

## `google-vertex` (Vertex AI / ADC)

Vertex uses Google Application Default Credentials (ADC), not API keys.

### Required auth/environment

```bash
gcloud auth application-default login
export GOOGLE_CLOUD_PROJECT="my-project"
export GOOGLE_CLOUD_LOCATION="us-central1"
```

For CI/production, set:

```bash
export GOOGLE_APPLICATION_CREDENTIALS="/path/to/service-account.json"
```

### Set a Vertex model

```bash
openclaw models set google-vertex/gemini-3.1-pro-preview
```

```json5
{
  agents: { defaults: { model: { primary: "google-vertex/gemini-3.1-pro-preview" } } },
}
```

## `google-gemini-cli` (OAuth)

This provider uses OAuth for Google Cloud Code Assist-style endpoints.

### Account safety caution

This integration is unofficial and not endorsed by Google. Some users have reported account restrictions or suspensions after using third-party Gemini CLI/OAuth clients. Use caution and a non-critical account.

### Setup

Wizard path:

```bash
openclaw onboard --auth-choice google-gemini-cli
```

Manual path:

```bash
openclaw plugins enable google-gemini-cli-auth
openclaw models auth login --provider google-gemini-cli --set-default
```

If `gemini` CLI is not installed, provide OAuth client credentials via
`OPENCLAW_GEMINI_OAUTH_CLIENT_ID` (+ optional
`OPENCLAW_GEMINI_OAUTH_CLIENT_SECRET`) or
`GEMINI_CLI_OAUTH_CLIENT_ID` (+ optional `GEMINI_CLI_OAUTH_CLIENT_SECRET`).

If requests fail on paid tiers, set `GOOGLE_CLOUD_PROJECT` or `GOOGLE_CLOUD_PROJECT_ID`.
OAuth profiles are stored as `google-gemini-cli:<email>` when email is available
(otherwise `google-gemini-cli:default`), so multiple Google accounts can coexist.

## Antigravity status (removed)

Google Antigravity is no longer supported in OpenClaw.

Breaking change summary:

- Removed Google Antigravity provider support.
- Existing `google-antigravity/*` model/profile configs no longer work.
- Migrate to `google-gemini-cli/*` or another supported provider.

## Troubleshooting

### `No API key found for provider "google"`

Set `GEMINI_API_KEY` (or another key from the rotation list), or add a Google auth profile.

### Vertex shows unauthenticated

Run `gcloud auth application-default login` and ensure required Vertex env vars
are set (typically `GOOGLE_CLOUD_PROJECT` and `GOOGLE_CLOUD_LOCATION`).

## Related

- [Model providers](/concepts/model-providers)
- [OAuth](/concepts/oauth)
- [Model failover](/concepts/model-failover)
