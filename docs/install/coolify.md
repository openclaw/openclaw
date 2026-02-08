---
title: Coolify
description: Deploy OpenClaw on a self-hosted Coolify instance
---

# Coolify Deployment

**Goal:** OpenClaw Gateway running on [Coolify](https://coolify.io) with persistent storage and automatic HTTPS.

## What you need

- A Coolify instance (v4+) with a connected server
- A domain pointed at your Coolify server
- An API key from a [model provider](/providers) — or try [OpenCode Zen](https://opencode.ai) for free multi-model access

## Deploy

### 1. Create a new resource

In your Coolify dashboard, click **Add New Resource** on your server. Select **Public Repository** and paste:

```
https://github.com/openclaw/openclaw.git
```

Set the branch to `main` and select **Dockerfile** as the build pack.

### 2. Configure domain and port

In the General settings:

1. Set your **Domain** (e.g. `https://openclaw.example.com`)
2. Set **Ports Exposes** to `18789`

Coolify handles HTTPS certificates and WebSocket routing through Traefik automatically.

### 3. Set environment variables

In the **Environment Variables** tab, add:

| Variable                 | Value        | Description                                                                |
| ------------------------ | ------------ | -------------------------------------------------------------------------- |
| `OPENCLAW_GATEWAY_TOKEN` | _(generate)_ | Secret token for gateway access. Generate one with `openssl rand -hex 32`. |
| `DOCKER_BUILDKIT`        | `1`          | Ensures the Docker build uses BuildKit. Required for the build to succeed. |

`NODE_ENV` and `HOME` are already set in the Dockerfile and do not need to be added here.

### 4. Add persistent storage

In the **Persistent Storages** tab, add a volume:

- **Destination Path**: `/home/node/.openclaw`

This volume stores configuration, API keys, sessions, and paired devices across redeployments.

### 5. Deploy

Click **Deploy**. The first build takes a few minutes. Watch the build logs for progress.

### 6. Fix volume permissions (one-time)

Docker creates the volume as `root`, but the container runs as `node`. Fix this from the Coolify root terminal:

1. Open **Terminal** in the Coolify sidebar
2. Select your **server** (top entry in the dropdown, e.g. "ServerCoolify") and click **Connect**
3. Find your container name — it starts with the app ID from your Coolify URL. For example, if your app URL is `.../application/y0sgwsg4cc8gcsckw408gkks`, the container is named `y0sgwsg4cc8gcsckw408gkks-...`. You can also find it in the Terminal dropdown list.
4. Run:

```bash
docker exec -u 0 <container-name> chown -R node:node /home/node/.openclaw
```

### 7. Configure LAN binding (one-time)

After fixing permissions in step 6, create a config file to bind the gateway to all interfaces. Coolify's Traefik proxy needs this to reach the gateway. From the **container** terminal:

1. In the Terminal dropdown, select your **container** (not the server) and click **Connect**
2. Run:

```bash
echo '{"gateway":{"bind":"lan","mode":"local"}}' > /home/node/.openclaw/openclaw.json
```

3. Click **Redeploy** in the Coolify dashboard.

Steps 6 and 7 are one-time setup. The volume permissions and config persist across redeployments.

## Connect

1. Visit `https://your-domain.example.com`
2. Paste your gateway token in the **Gateway Token** field and click **Save**
3. Click **Connect** — you will see "pairing required"
4. Approve the device from the container terminal:

```bash
node dist/index.js devices list
node dist/index.js devices approve <request-id>
```

5. Go back to the browser and click **Connect** again — you should now be connected

Connections through Coolify's Traefik proxy appear as non-local, so every new device needs manual approval. Pending requests expire after 5 minutes.

## Set up your bot

From the container terminal, run the onboarding wizard:

```bash
node dist/index.js onboard
```

This walks you through selecting a model provider, configuring API keys, and optionally setting up messaging channels (Telegram, Discord, Slack, etc.) and skills.

You can also configure providers and channels later through the Control UI dashboard.

**Tip:** [OpenCode Zen](https://opencode.ai) is a multi-model proxy that gives access to Claude, GPT, Gemini, and other models. They offer free models that are great for testing your deployment.

## Troubleshooting

- **Bad Gateway after deploy**: Make sure you completed steps 6 and 7 (volume permissions + config) and clicked Redeploy. The gateway must bind to LAN for Traefik to reach it.

- **Volume permissions** (`EACCES` errors): Re-run the `chown` command from step 6 using the server terminal.

- **Build fails with "--progress" error**: Coolify passes `--progress plain` to the build command, which requires BuildKit. Ensure the `DOCKER_BUILDKIT` environment variable is set to `1` so Docker uses the BuildKit builder.

- **"Pairing required" on connect**: Approve the device from the container terminal with `node dist/index.js devices approve <request-id>`. Use `node dist/index.js devices list` to find pending requests.

- **"Untrusted proxy" log warnings**: The gateway logs warnings when requests arrive through an unconfigured proxy. This does not affect functionality. To suppress, add `gateway.trustedProxies` to your [configuration](/gateway/configuration#trusted-proxies) with the proxy IP.

- **CLI binary not found**: Inside the container, use `node dist/index.js <command>` instead of the `openclaw` binary.

## Updates

Click **Redeploy** in the Coolify dashboard. Coolify rebuilds the image from the latest source. Your data persists in the volume across redeployments.
