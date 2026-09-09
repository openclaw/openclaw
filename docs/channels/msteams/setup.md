---
summary: "Install the Microsoft Teams plugin, register the bot and Teams app, and run against a dev tunnel"
read_when:
  - Setting up the Microsoft Teams channel for the first time
  - Registering an Azure Bot and Teams app by hand
  - Running Teams against a local dev tunnel
title: "Microsoft Teams setup"
sidebarTitle: "Setup"
---

Install the plugin, register the bot and Teams app, point Teams at a reachable endpoint, and verify the result.

## Bundled plugin

Microsoft Teams ships as a bundled plugin in current OpenClaw releases; no separate install is required in the normal packaged build.

On an older build or a custom install that excludes bundled Teams, install the npm package directly:

```bash
openclaw plugins install @openclaw/msteams
```

Use the bare package to follow the current official release tag. Pin an exact version only when you need a reproducible install.

Local checkout (running from a git repo):

```bash
openclaw plugins install ./path/to/local/msteams-plugin
```

Details: [Plugins](/tools/plugin)

## Quick setup

[`@microsoft/teams.cli`](https://www.npmjs.com/package/@microsoft/teams.cli) handles bot registration, manifest creation, and credential generation in one command.

**1. Install and log in**

```bash
npm install -g @microsoft/teams.cli@preview
teams login
teams status   # verify you're logged in and see your tenant info
```

<Note>
The Teams CLI is currently in preview. Commands and flags may change between releases.
</Note>

**2. Start a tunnel** (Teams cannot reach localhost)

Install and authenticate the devtunnel CLI if needed ([getting started guide](https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/get-started)).

```bash
# One-time setup (persistent URL across sessions):
devtunnel create my-openclaw-bot --allow-anonymous
devtunnel port create my-openclaw-bot -p 3978 --protocol auto

# Each dev session:
devtunnel host my-openclaw-bot
# Your endpoint: https://<tunnel-id>.devtunnels.ms/api/messages
```

<Note>
`--allow-anonymous` is required because Teams cannot authenticate with devtunnels. Each incoming bot request is still validated by the Teams SDK.
</Note>

Alternatives: `ngrok http 3978` or `tailscale funnel 3978` (URLs may change each session).

**3. Create the app**

```bash
teams app create \
  --name "OpenClaw" \
  --endpoint "https://<your-tunnel-url>/api/messages"
```

This creates an Entra ID (Azure AD) application, generates a client secret, builds and uploads a Teams app manifest (with icons), and registers a Teams-managed bot (no Azure subscription needed). The output includes `CLIENT_ID`, `CLIENT_SECRET`, `TENANT_ID`, and a **Teams App ID**; it also offers to install the app in Teams directly.

**4. Configure OpenClaw** using the credentials from the output:

```json5
{
  channels: {
    msteams: {
      enabled: true,
      appId: "<CLIENT_ID>",
      appPassword: "<CLIENT_SECRET>",
      tenantId: "<TENANT_ID>",
      webhook: { port: 3978, path: "/api/messages" },
    },
  },
}
```

Or use environment variables directly: `MSTEAMS_APP_ID`, `MSTEAMS_APP_PASSWORD`, `MSTEAMS_TENANT_ID`.

**5. Install the app in Teams**

`teams app create` prompts you to install the app; select "Install in Teams". To get the install link later:

```bash
teams app get <teamsAppId> --install-link
```

**6. Verify everything works**

```bash
teams app doctor <teamsAppId>
```

Runs diagnostics across bot registration, AAD app config, manifest validity, and SSO setup.

For production, consider [federated authentication](/channels/msteams/authentication#federated-authentication-certificate-plus-managed-identity) (certificate or managed identity) instead of client secrets.

<Note>
Group chats are blocked by default (`channels.msteams.groupPolicy: "allowlist"`). To allow group replies, set `channels.msteams.groupAllowFrom`, or use `groupPolicy: "open"` to allow any member (mention-gated).
</Note>

## Goals

- Talk to OpenClaw via Teams DMs, group chats, or channels.
- Keep routing deterministic: replies always go back to the channel they arrived on.
- Default to safe channel behavior (mentions required unless configured otherwise).

<details>
<summary><strong>Manual setup (without the Teams CLI)</strong></summary>

### How it works

1. Ensure the Microsoft Teams plugin is available (bundled in current releases).
2. Create an **Azure Bot** (App ID + secret + tenant ID).
3. Build a **Teams app package** referencing the bot, including the [RSC permissions](/channels/msteams/manifest-and-permissions#current-teams-rsc-permissions-manifest).
4. Upload/install the Teams app into a team (or personal scope for DMs).
5. Configure `msteams` in `~/.openclaw/openclaw.json` (or env vars) and start the gateway.
6. The gateway listens for Bot Framework webhook traffic on `/api/messages` by default.

### Step 1: Create Azure Bot

1. Go to [Create Azure Bot](https://portal.azure.com/#create/Microsoft.AzureBot)
2. Fill in the **Basics** tab:

   | Field              | Value                                                    |
   | ------------------ | -------------------------------------------------------- |
   | **Bot handle**     | Your bot name, e.g., `openclaw-msteams` (must be unique) |
   | **Subscription**   | Select your Azure subscription                           |
   | **Resource group** | Create new or use existing                               |
   | **Pricing tier**   | **Free** for dev/testing                                 |
   | **Type of App**    | **Single Tenant** (recommended; see note below)          |
   | **Creation type**  | **Create new Microsoft App ID**                          |

<Warning>
Creation of new multi-tenant bots was deprecated after 2025-07-31. Use **Single Tenant** for new bots.
</Warning>

3. Click **Review + create** then **Create** (~1-2 minutes).

### Step 2: Get credentials

1. Azure Bot resource → **Configuration** → copy **Microsoft App ID** (your `appId`).
2. **Manage Password** → App Registration → **Certificates & secrets** → **New client secret** → copy the **Value** (your `appPassword`).
3. **Overview** → copy **Directory (tenant) ID** (your `tenantId`).

### Step 3: Configure messaging endpoint

1. Azure Bot → **Configuration**.
2. Set **Messaging endpoint**:
   - Production: `https://your-domain.com/api/messages`
   - Local dev: use a tunnel (see [Local development](#local-development-tunneling))

### Step 4: Enable Teams channel

1. Azure Bot → **Channels**.
2. Click **Microsoft Teams** → Configure → Save.
3. Accept the Terms of Service.

### Step 5: Build Teams app manifest

- Include a `bot` entry with `botId = <App ID>`.
- Scopes: `personal`, `team`, `groupChat`.
- `supportsFiles: true` (required for personal-scope file handling).
- Add RSC permissions (see [RSC permissions](/channels/msteams/manifest-and-permissions#current-teams-rsc-permissions-manifest)).
- Create icons: `outline.png` (32x32) and `color.png` (192x192).
- Zip `manifest.json`, `outline.png`, and `color.png` together.

### Step 6: Configure OpenClaw

```json5
{
  channels: {
    msteams: {
      enabled: true,
      appId: "<APP_ID>",
      appPassword: "<APP_PASSWORD>",
      tenantId: "<TENANT_ID>",
      webhook: { port: 3978, path: "/api/messages" },
    },
  },
}
```

Environment variables: `MSTEAMS_APP_ID`, `MSTEAMS_APP_PASSWORD`, `MSTEAMS_TENANT_ID`.

### Step 7: Run the gateway

The Teams channel starts automatically when the plugin is available and `msteams` config has credentials.

</details>

## Local development (tunneling)

Teams cannot reach `localhost`. Use a persistent dev tunnel so the URL stays stable across sessions:

```bash
# One-time setup:
devtunnel create my-openclaw-bot --allow-anonymous
devtunnel port create my-openclaw-bot -p 3978 --protocol auto

# Each dev session:
devtunnel host my-openclaw-bot
```

Alternatives: `ngrok http 3978` or `tailscale funnel 3978` (URLs may change each session).

If the tunnel URL changes, update the endpoint:

```bash
teams app update <teamsAppId> --endpoint "https://<new-url>/api/messages"
```

## Testing the bot

**Run diagnostics:**

```bash
teams app doctor <teamsAppId>
```

Checks bot registration, AAD app, manifest, and SSO configuration in one pass.

**Send a test message:**

1. Install the Teams app (install link from `teams app get <id> --install-link`).
2. Find the bot in Teams and send a DM.
3. Check gateway logs for incoming activity.
