---
title: Gmail Config-Driven Setup
description: Configure Gmail webhooks entirely via openclaw.json without interactive CLI wizards
---

# Gmail Config-Driven Setup

Configure Gmail webhooks entirely through `openclaw.json` without running interactive CLI wizards. This is ideal for automated deployments on platforms like Fly.io, Railway, or Kubernetes.

## Overview

The standard `openclaw webhooks gmail setup` wizard requires interactive authentication with Google and Tailscale. The config-driven approach allows you to:

- Use **GCP Service Account** credentials instead of user OAuth
- Inject **gog credentials** via refresh token
- Configure **Google API services** — Gmail, Sheets, Drive, Calendar, Docs
- Use **Tailscale auth key** for automated connection
- **Auto-create** Pub/Sub topics and subscriptions on startup

## Quick Start

```json
{
  "hooks": {
    "enabled": true,
    "token": "${OPENCLAW_HOOK_TOKEN}",
    "gmail": {
      "account": "your-email@gmail.com",
      "topic": "projects/your-project/topics/openclaw-gmail",
      "subscription": "openclaw-gmail-push",
      "pushToken": "${GMAIL_PUSH_TOKEN}",
      "gcp": {
        "projectId": "your-project",
        "serviceAccountKey": "${GCP_SERVICE_ACCOUNT_JSON}",
        "autoSetup": true
      },
      "gog": {
        "clientId": "${GOG_CLIENT_ID}",
        "clientSecret": "${GOG_CLIENT_SECRET}",
        "refreshToken": "${GOG_REFRESH_TOKEN}",
        "services": ["gmail", "sheets", "drive", "calendar", "docs"],
        "scopes": [
          "https://www.googleapis.com/auth/gmail.modify",
          "https://www.googleapis.com/auth/gmail.settings.basic",
          "https://www.googleapis.com/auth/userinfo.email",
          "https://www.googleapis.com/auth/spreadsheets",
          "https://www.googleapis.com/auth/drive",
          "https://www.googleapis.com/auth/calendar",
          "https://www.googleapis.com/auth/documents"
        ]
      },
      "tailscale": {
        "mode": "funnel",
        "authKey": "${TS_AUTHKEY}",
        "path": "/gmail-pubsub"
      }
    }
  }
}
```

## Configuration Reference

### GCP Configuration (`gcp`)

| Field                   | Type    | Description                                              |
| ----------------------- | ------- | -------------------------------------------------------- |
| `projectId`             | string  | GCP project ID (can also be inferred from topic path)    |
| `serviceAccountKey`     | string  | Service account JSON key (string or `${ENV_VAR}`)        |
| `serviceAccountKeyFile` | string  | Path to service account JSON key file                    |
| `autoSetup`             | boolean | Auto-create Pub/Sub topic, subscription, and enable APIs |

### gog Credentials (`gog`)

| Field             | Type     | Description                                                                                      |
| ----------------- | -------- | ------------------------------------------------------------------------------------------------ |
| `clientId`        | string   | OAuth client ID from your GCP project                                                            |
| `clientSecret`    | string   | OAuth client secret                                                                              |
| `refreshToken`    | string   | OAuth refresh token (from local `gog auth login`)                                                |
| `credentialsFile` | string   | Path to existing gog credentials.json to copy                                                    |
| `services`        | string[] | Google API services to enable (default: `["gmail"]`). Add `"sheets"`, `"drive"`, `"docs"` etc.   |
| `scopes`          | string[] | OAuth scopes to request (default: Gmail scopes only). See [Scopes](#google-api-scopes) for list. |

### Google API Scopes

When adding Sheets, Drive, or Docs access, include the relevant scopes in `gog.scopes` and services in `gog.services`. Your refresh token must have been granted these scopes during `gog auth login`.

```json
{
  "gog": {
    "services": ["gmail", "sheets", "drive"],
    "scopes": [
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/gmail.settings.basic",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/spreadsheets",
      "https://www.googleapis.com/auth/drive",
      "https://www.googleapis.com/auth/documents"
    ]
  }
}
```

Common scopes:

| Scope                                                   | Service | Access                    |
| ------------------------------------------------------- | ------- | ------------------------- |
| `https://www.googleapis.com/auth/gmail.modify`          | Gmail   | Read/write messages       |
| `https://www.googleapis.com/auth/gmail.settings.basic`  | Gmail   | Manage labels and filters |
| `https://www.googleapis.com/auth/spreadsheets`          | Sheets  | Read/write spreadsheets   |
| `https://www.googleapis.com/auth/spreadsheets.readonly` | Sheets  | Read-only spreadsheets    |
| `https://www.googleapis.com/auth/drive`                 | Drive   | Full Drive access         |
| `https://www.googleapis.com/auth/drive.readonly`        | Drive   | Read-only Drive access    |
| `https://www.googleapis.com/auth/drive.file`            | Drive   | Files created by the app  |
| `https://www.googleapis.com/auth/documents`             | Docs    | Read/write documents      |
| `https://www.googleapis.com/auth/documents.readonly`    | Docs    | Read-only documents       |

<Tip>
Your refresh token must include all requested scopes. If adding new scopes, re-run `gog auth login` locally with the additional scopes, then update the refresh token in your secrets.
</Tip>

### Tailscale Configuration (`tailscale`)

| Field     | Type                               | Description                               |
| --------- | ---------------------------------- | ----------------------------------------- |
| `mode`    | `"off"` \| `"serve"` \| `"funnel"` | Tailscale mode for public endpoint        |
| `authKey` | string                             | Tailscale auth key for automated login    |
| `path`    | string                             | Public path for Gmail push endpoint       |
| `target`  | string                             | Optional target (port, host:port, or URL) |

## Setup Steps

### 1. Create GCP Service Account

```bash
# Create service account
gcloud iam service-accounts create openclaw-gmail \
  --display-name="OpenClaw Gmail Service Account"

# Grant required roles
gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
  --member="serviceAccount:openclaw-gmail@YOUR_PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/pubsub.admin"

# Create and download key
gcloud iam service-accounts keys create sa-key.json \
  --iam-account=openclaw-gmail@YOUR_PROJECT_ID.iam.gserviceaccount.com
```

Store the key content as a secret:

```bash
fly secrets set GCP_SERVICE_ACCOUNT_JSON="$(cat sa-key.json)" -a your-app
```

### 2. Get gog OAuth Credentials

Run this **locally once** to get the refresh token. Include all services you need:

```bash
# Install gog
curl -fsSL https://gogcli.sh/install.sh | bash

# Authorize with desired services (opens browser)
gog auth login --account your-email@gmail.com \
  --services "gmail,sheets,drive,calendar,docs" --force-consent

# Export refresh token
gog auth tokens export your-email@gmail.com --out /tmp/gog-token.json
```

Store the credentials:

```bash
fly secrets set GOG_CLIENT_ID="your-client-id" \
  GOG_CLIENT_SECRET="your-client-secret" \
  GOG_REFRESH_TOKEN="your-refresh-token" \
  -a your-app
```

### 3. Get Tailscale Auth Key

1. Go to [Tailscale Admin Console](https://login.tailscale.com/admin/settings/keys)
2. Generate an **Auth Key** (reusable, with tags if needed)
3. Store it:

```bash
fly secrets set TS_AUTHKEY="tskey-auth-..." -a your-app
```

### 4. Generate Hook Tokens

```bash
fly secrets set \
  OPENCLAW_HOOK_TOKEN="$(openssl rand -hex 24)" \
  GMAIL_PUSH_TOKEN="$(openssl rand -hex 24)" \
  -a your-app
```

## How It Works

On gateway startup, if `gcp.autoSetup: true`:

1. **Service Account Auth**: If `serviceAccountKey` is provided and gcloud isn't authenticated, authenticates using the service account
2. **gog Credentials**: If `gog.refreshToken` is provided, creates the necessary credential files
3. **Tailscale Connect**: If `tailscale.authKey` is provided and Tailscale isn't connected, runs `tailscale up --authkey`
4. **Pub/Sub Setup**: Enables required APIs, creates topic with IAM binding, creates subscription with push endpoint
5. **Gmail Watch**: Starts the Gmail watch and spawns gog serve

## Troubleshooting

### "gog binary not found"

Install gog in your Dockerfile:

```dockerfile
RUN curl -fsSL https://gogcli.sh/install.sh | bash
```

### "tailscale up failed"

Ensure your Tailscale auth key is valid and has the required tags. On Fly.io, you may need to configure the machine to support Tailscale.

### "Service account key file not found"

When using `serviceAccountKeyFile`, ensure the path is correct relative to the container. Consider using `serviceAccountKey` with the JSON content directly from an environment variable.

### "projectId required for autoSetup"

Either set `gcp.projectId` or include the project ID in the topic path:

```json
"topic": "projects/your-project/topics/openclaw-gmail"
```

## Security Best Practices

1. **Never commit credentials** - Use environment variables with `${VAR}` syntax
2. **Rotate auth keys** - Generate new Tailscale auth keys periodically
3. **Limit service account scope** - Only grant `roles/pubsub.admin`, not broader roles
4. **Use app-scoped OAuth** - Create a dedicated OAuth client for OpenClaw

## Related

- [Gmail Pub/Sub Setup](/automation/gmail-pubsub) - Standard interactive setup
- [Hooks Configuration](/configuration#hooks) - General hooks configuration
- [Environment Variables](/help/environment) - Using `${VAR}` in config
