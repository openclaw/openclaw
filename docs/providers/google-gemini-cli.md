---
summary: "Import and use the official Gemini CLI OAuth cache"
title: "Gemini CLI OAuth"
read_when:
  - You want to reuse an official Gemini CLI Google sign-in
  - You need to configure the google-gemini-cli runtime without an OpenClaw-owned OAuth client
---

The `google-gemini-cli` runtime reuses credentials created by the official Gemini CLI.
OpenClaw does not launch or own a Google OAuth client for this path.

## Setup

1. Install the official Gemini CLI and run:

   ```bash
   gemini
   ```

2. Choose **Sign in with Google** and complete login.

3. Import the cache into OpenClaw:

   ```bash
   openclaw models auth login --provider google-gemini-cli --set-default
   ```

OpenClaw reads `oauth_creds.json` from
`GEMINI_CLI_HOME/.gemini/oauth_creds.json` when `GEMINI_CLI_HOME` is set,
otherwise from `~/.gemini/oauth_creds.json`.

The import fails closed unless `google_accounts.json` identifies an active Google
account. When the OAuth cache also contains an email, it must match that active
account. This prevents a stale cache from being saved under the wrong profile.

## Runtime

Use canonical `google/*` model refs and select the Gemini CLI runtime:

```json5
{
  agents: {
    defaults: {
      models: {
        "google/gemini-3.1-pro-preview": {
          agentRuntime: { id: "google-gemini-cli" },
        },
      },
    },
  },
}
```

The imported profile is staged into an isolated Gemini CLI home for execution.
The official CLI owns token refresh. If the imported cache expires, run `gemini`
again and repeat the OpenClaw import.

Optional environment variables:

- `GEMINI_CLI_HOME` selects a non-default Gemini CLI home.
- `GOOGLE_CLOUD_PROJECT` or `GOOGLE_CLOUD_PROJECT_ID` pins a project id.

For API-key use, configure `GEMINI_API_KEY` or `GOOGLE_API_KEY` with the `google`
provider instead.
