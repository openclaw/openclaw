# Google Gemini CLI OAuth

Gemini CLI uses a **plugin-based OAuth flow** for authentication. This guide covers setting up single or multiple Google accounts.

## Prerequisites

Enable the bundled plugin:

```bash
openclaw plugins enable google-gemini-cli-auth
```

## Single Account Setup

```bash
openclaw models auth login --provider google-gemini-cli --set-default
```

Browser opens for Google authentication. Sign in and authorize access.

## Multiple Account Setup

You can add multiple Google accounts for automatic failover when one hits rate limits.

### Step 1: Get a GCP Project ID

1. Open [Google Cloud Console](https://console.cloud.google.com/)
2. Select or create a project
3. Note the Project ID (e.g., `my-project-123456`)

### Step 2: Enable Cloud Code Assist API

Enable the API for your project:

```
https://console.developers.google.com/apis/api/cloudaicompanion.googleapis.com/overview?project=YOUR_PROJECT_ID
```

Click **"Enable"** and wait a few minutes for propagation.

### Step 3: Run OAuth Login

```bash
GOOGLE_CLOUD_PROJECT="YOUR_PROJECT_ID" openclaw models auth login --provider google-gemini-cli
```

Sign in with the Google account you want to add. The system creates a profile based on your email:

```
google-gemini-cli:user@gmail.com
```

### Step 4: Verify

```bash
openclaw models status --probe --probe-profile "google-gemini-cli:user@gmail.com" --probe-timeout 30000
```

Look for `ok` in the Status column.

### Adding More Accounts

Repeat steps 1-4 with different Google accounts. Each account needs its own GCP project with the API enabled.

## Viewing Configured Profiles

```bash
openclaw models status --probe
```

Or inspect the auth store directly:

```bash
cat ~/.openclaw/agents/main/agent/auth-profiles.json
```

## Using Specific Profiles

### In Configuration

```json
{
  "agents": {
    "defaults": {
      "models": {
        "google-gemini-cli/gemini-3-pro-preview": {
          "profiles": ["google-gemini-cli:preferred@gmail.com"]
        }
      }
    }
  }
}
```

### In Failover

Use `provider:email` format:

```json
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "google-gemini-cli/gemini-3-pro-preview",
        "fallbacks": ["google-gemini-cli:backup@gmail.com/gemini-3-pro-preview"]
      }
    }
  }
}
```

## Troubleshooting

| Error                           | Solution                                                |
| ------------------------------- | ------------------------------------------------------- |
| `GOOGLE_CLOUD_PROJECT required` | Set the environment variable before login               |
| `403: API not enabled`          | Enable Cloud Code Assist API in GCP Console             |
| `auth error / cooldown`         | Wait for cooldown to expire or re-login                 |
| `timeout`                       | Increase `--probe-timeout` or wait for API to propagate |

### Clearing Cooldown

Re-authenticate to reset error state:

```bash
GOOGLE_CLOUD_PROJECT="YOUR_PROJECT_ID" openclaw models auth login --provider google-gemini-cli
```

## Available Models

- `google-gemini-cli/gemini-3-pro-preview`
- `google-gemini-cli/gemini-3-flash-preview`

## Related

- [Model Providers](/concepts/model-providers) — Overview of all providers
- [Model Failover](/concepts/model-failover) — Automatic failover configuration
