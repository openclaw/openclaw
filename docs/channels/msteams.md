---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Microsoft Teams bot support status, capabilities, and configuration"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Working on MS Teams channel features（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Microsoft Teams"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Microsoft Teams (plugin)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
> "Abandon all hope, ye who enter here."（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Updated: 2026-01-21（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Status: text + DM attachments are supported; channel/group file sending requires `sharePointSiteId` + Graph permissions (see [Sending files in group chats](#sending-files-in-group-chats)). Polls are sent via Adaptive Cards.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Plugin required（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Microsoft Teams ships as a plugin and is not bundled with the core install.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Breaking change (2026.1.15):** MS Teams moved out of core. If you use it, you must install the plugin.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Explainable: keeps core installs lighter and lets MS Teams dependencies update independently.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Install via CLI (npm registry):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw plugins install @openclaw/msteams（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Local checkout (when running from a git repo):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw plugins install ./extensions/msteams（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you choose Teams during configure/onboarding and a git checkout is detected,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw will offer the local install path automatically.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Details: [Plugins](/tools/plugin)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Quick setup (beginner)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Install the Microsoft Teams plugin.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Create an **Azure Bot** (App ID + client secret + tenant ID).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Configure OpenClaw with those credentials.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Expose `/api/messages` (port 3978 by default) via a public URL or tunnel.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
5. Install the Teams app package and start the gateway.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Minimal config:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    msteams: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      enabled: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      appId: "<APP_ID>",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      appPassword: "<APP_PASSWORD>",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      tenantId: "<TENANT_ID>",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      webhook: { port: 3978, path: "/api/messages" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Note: group chats are blocked by default (`channels.msteams.groupPolicy: "allowlist"`). To allow group replies, set `channels.msteams.groupAllowFrom` (or use `groupPolicy: "open"` to allow any member, mention-gated).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Goals（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Talk to OpenClaw via Teams DMs, group chats, or channels.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Keep routing deterministic: replies always go back to the channel they arrived on.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Default to safe channel behavior (mentions required unless configured otherwise).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Config writes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
By default, Microsoft Teams is allowed to write config updates triggered by `/config set|unset` (requires `commands.config: true`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Disable with:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: { msteams: { configWrites: false } },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Access control (DMs + groups)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**DM access**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Default: `channels.msteams.dmPolicy = "pairing"`. Unknown senders are ignored until approved.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.msteams.allowFrom` accepts AAD object IDs, UPNs, or display names. The wizard resolves names to IDs via Microsoft Graph when credentials allow.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Group access**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Default: `channels.msteams.groupPolicy = "allowlist"` (blocked unless you add `groupAllowFrom`). Use `channels.defaults.groupPolicy` to override the default when unset.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.msteams.groupAllowFrom` controls which senders can trigger in group chats/channels (falls back to `channels.msteams.allowFrom`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Set `groupPolicy: "open"` to allow any member (still mention‑gated by default).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- To allow **no channels**, set `channels.msteams.groupPolicy: "disabled"`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    msteams: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      groupPolicy: "allowlist",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      groupAllowFrom: ["user@org.com"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Teams + channel allowlist**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Scope group/channel replies by listing teams and channels under `channels.msteams.teams`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Keys can be team IDs or names; channel keys can be conversation IDs or names.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- When `groupPolicy="allowlist"` and a teams allowlist is present, only listed teams/channels are accepted (mention‑gated).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The configure wizard accepts `Team/Channel` entries and stores them for you.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- On startup, OpenClaw resolves team/channel and user allowlist names to IDs (when Graph permissions allow)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  and logs the mapping; unresolved entries are kept as typed.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    msteams: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      groupPolicy: "allowlist",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      teams: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "My Team": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            General: { requireMention: true },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## How it works（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Install the Microsoft Teams plugin.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Create an **Azure Bot** (App ID + secret + tenant ID).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Build a **Teams app package** that references the bot and includes the RSC permissions below.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Upload/install the Teams app into a team (or personal scope for DMs).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
5. Configure `msteams` in `~/.openclaw/openclaw.json` (or env vars) and start the gateway.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
6. The gateway listens for Bot Framework webhook traffic on `/api/messages` by default.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Azure Bot Setup (Prerequisites)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Before configuring OpenClaw, you need to create an Azure Bot resource.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Step 1: Create Azure Bot（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Go to [Create Azure Bot](https://portal.azure.com/#create/Microsoft.AzureBot)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Fill in the **Basics** tab:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   | Field              | Value                                                    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   | ------------------ | -------------------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   | **Bot handle**     | Your bot name, e.g., `openclaw-msteams` (must be unique) |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   | **Subscription**   | Select your Azure subscription                           |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   | **Resource group** | Create new or use existing                               |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   | **Pricing tier**   | **Free** for dev/testing                                 |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   | **Type of App**    | **Single Tenant** (recommended - see note below)         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   | **Creation type**  | **Create new Microsoft App ID**                          |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
> **Deprecation notice:** Creation of new multi-tenant bots was deprecated after 2025-07-31. Use **Single Tenant** for new bots.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Click **Review + create** → **Create** (wait ~1-2 minutes)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Step 2: Get Credentials（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Go to your Azure Bot resource → **Configuration**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Copy **Microsoft App ID** → this is your `appId`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Click **Manage Password** → go to the App Registration（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Under **Certificates & secrets** → **New client secret** → copy the **Value** → this is your `appPassword`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
5. Go to **Overview** → copy **Directory (tenant) ID** → this is your `tenantId`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Step 3: Configure Messaging Endpoint（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. In Azure Bot → **Configuration**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Set **Messaging endpoint** to your webhook URL:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Production: `https://your-domain.com/api/messages`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Local dev: Use a tunnel (see [Local Development](#local-development-tunneling) below)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Step 4: Enable Teams Channel（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. In Azure Bot → **Channels**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Click **Microsoft Teams** → Configure → Save（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Accept the Terms of Service（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Local Development (Tunneling)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Teams can't reach `localhost`. Use a tunnel for local development:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Option A: ngrok**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
ngrok http 3978（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Copy the https URL, e.g., https://abc123.ngrok.io（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Set messaging endpoint to: https://abc123.ngrok.io/api/messages（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Option B: Tailscale Funnel**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
tailscale funnel 3978（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Use your Tailscale funnel URL as the messaging endpoint（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Teams Developer Portal (Alternative)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Instead of manually creating a manifest ZIP, you can use the [Teams Developer Portal](https://dev.teams.microsoft.com/apps):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Click **+ New app**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Fill in basic info (name, description, developer info)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Go to **App features** → **Bot**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Select **Enter a bot ID manually** and paste your Azure Bot App ID（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
5. Check scopes: **Personal**, **Team**, **Group Chat**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
6. Click **Distribute** → **Download app package**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
7. In Teams: **Apps** → **Manage your apps** → **Upload a custom app** → select the ZIP（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This is often easier than hand-editing JSON manifests.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Testing the Bot（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Option A: Azure Web Chat (verify webhook first)**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. In Azure Portal → your Azure Bot resource → **Test in Web Chat**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Send a message - you should see a response（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. This confirms your webhook endpoint works before Teams setup（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Option B: Teams (after app installation)**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Install the Teams app (sideload or org catalog)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Find the bot in Teams and send a DM（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Check gateway logs for incoming activity（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Setup (minimal text-only)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **Install the Microsoft Teams plugin**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - From npm: `openclaw plugins install @openclaw/msteams`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - From a local checkout: `openclaw plugins install ./extensions/msteams`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **Bot registration**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Create an Azure Bot (see above) and note:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
     - App ID（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
     - Client secret (App password)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
     - Tenant ID (single-tenant)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. **Teams app manifest**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Include a `bot` entry with `botId = <App ID>`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Scopes: `personal`, `team`, `groupChat`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - `supportsFiles: true` (required for personal scope file handling).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Add RSC permissions (below).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Create icons: `outline.png` (32x32) and `color.png` (192x192).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Zip all three files together: `manifest.json`, `outline.png`, `color.png`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. **Configure OpenClaw**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
     "msteams": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
       "enabled": true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
       "appId": "<APP_ID>",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
       "appPassword": "<APP_PASSWORD>",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
       "tenantId": "<TENANT_ID>",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
       "webhook": { "port": 3978, "path": "/api/messages" }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
     }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   You can also use environment variables instead of config keys:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - `MSTEAMS_APP_ID`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - `MSTEAMS_APP_PASSWORD`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - `MSTEAMS_TENANT_ID`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
5. **Bot endpoint**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Set the Azure Bot Messaging Endpoint to:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
     - `https://<host>:3978/api/messages` (or your chosen path/port).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
6. **Run the gateway**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - The Teams channel starts automatically when the plugin is installed and `msteams` config exists with credentials.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## History context（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.msteams.historyLimit` controls how many recent channel/group messages are wrapped into the prompt.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Falls back to `messages.groupChat.historyLimit`. Set `0` to disable (default 50).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- DM history can be limited with `channels.msteams.dmHistoryLimit` (user turns). Per-user overrides: `channels.msteams.dms["<user_id>"].historyLimit`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Current Teams RSC Permissions (Manifest)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
These are the **existing resourceSpecific permissions** in our Teams app manifest. They only apply inside the team/chat where the app is installed.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**For channels (team scope):**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `ChannelMessage.Read.Group` (Application) - receive all channel messages without @mention（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `ChannelMessage.Send.Group` (Application)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `Member.Read.Group` (Application)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `Owner.Read.Group` (Application)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `ChannelSettings.Read.Group` (Application)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `TeamMember.Read.Group` (Application)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `TeamSettings.Read.Group` (Application)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**For group chats:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `ChatMessage.Read.Chat` (Application) - receive all group chat messages without @mention（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Example Teams Manifest (redacted)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Minimal, valid example with the required fields. Replace IDs and URLs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "$schema": "https://developer.microsoft.com/en-us/json-schemas/teams/v1.23/MicrosoftTeams.schema.json",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "manifestVersion": "1.23",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "version": "1.0.0",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "id": "00000000-0000-0000-0000-000000000000",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "name": { "short": "OpenClaw" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "developer": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "name": "Your Org",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "websiteUrl": "https://example.com",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "privacyUrl": "https://example.com/privacy",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "termsOfUseUrl": "https://example.com/terms"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "description": { "short": "OpenClaw in Teams", "full": "OpenClaw in Teams" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "icons": { "outline": "outline.png", "color": "color.png" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "accentColor": "#5B6DEF",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "bots": [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "botId": "11111111-1111-1111-1111-111111111111",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "scopes": ["personal", "team", "groupChat"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "isNotificationOnly": false,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "supportsCalling": false,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "supportsVideo": false,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "supportsFiles": true（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "webApplicationInfo": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "id": "11111111-1111-1111-1111-111111111111"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "authorization": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "permissions": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "resourceSpecific": [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        { "name": "ChannelMessage.Read.Group", "type": "Application" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        { "name": "ChannelMessage.Send.Group", "type": "Application" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        { "name": "Member.Read.Group", "type": "Application" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        { "name": "Owner.Read.Group", "type": "Application" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        { "name": "ChannelSettings.Read.Group", "type": "Application" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        { "name": "TeamMember.Read.Group", "type": "Application" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        { "name": "TeamSettings.Read.Group", "type": "Application" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        { "name": "ChatMessage.Read.Chat", "type": "Application" }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      ]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Manifest caveats (must-have fields)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `bots[].botId` **must** match the Azure Bot App ID.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `webApplicationInfo.id` **must** match the Azure Bot App ID.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `bots[].scopes` must include the surfaces you plan to use (`personal`, `team`, `groupChat`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `bots[].supportsFiles: true` is required for file handling in personal scope.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `authorization.permissions.resourceSpecific` must include channel read/send if you want channel traffic.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Updating an existing app（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
To update an already-installed Teams app (e.g., to add RSC permissions):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Update your `manifest.json` with the new settings（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **Increment the `version` field** (e.g., `1.0.0` → `1.1.0`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. **Re-zip** the manifest with icons (`manifest.json`, `outline.png`, `color.png`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Upload the new zip:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - **Option A (Teams Admin Center):** Teams Admin Center → Teams apps → Manage apps → find your app → Upload new version（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - **Option B (Sideload):** In Teams → Apps → Manage your apps → Upload a custom app（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
5. **For team channels:** Reinstall the app in each team for new permissions to take effect（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
6. **Fully quit and relaunch Teams** (not just close the window) to clear cached app metadata（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Capabilities: RSC only vs Graph（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### With **Teams RSC only** (app installed, no Graph API permissions)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Works:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Read channel message **text** content.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Send channel message **text** content.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Receive **personal (DM)** file attachments.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Does NOT work:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Channel/group **image or file contents** (payload only includes HTML stub).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Downloading attachments stored in SharePoint/OneDrive.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Reading message history (beyond the live webhook event).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### With **Teams RSC + Microsoft Graph Application permissions**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Adds:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Downloading hosted contents (images pasted into messages).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Downloading file attachments stored in SharePoint/OneDrive.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Reading channel/chat message history via Graph.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### RSC vs Graph API（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Capability              | RSC Permissions      | Graph API                           |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ----------------------- | -------------------- | ----------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Real-time messages**  | Yes (via webhook)    | No (polling only)                   |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Historical messages** | No                   | Yes (can query history)             |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Setup complexity**    | App manifest only    | Requires admin consent + token flow |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Works offline**       | No (must be running) | Yes (query anytime)                 |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Bottom line:** RSC is for real-time listening; Graph API is for historical access. For catching up on missed messages while offline, you need Graph API with `ChannelMessage.Read.All` (requires admin consent).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Graph-enabled media + history (required for channels)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you need images/files in **channels** or want to fetch **message history**, you must enable Microsoft Graph permissions and grant admin consent.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. In Entra ID (Azure AD) **App Registration**, add Microsoft Graph **Application permissions**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - `ChannelMessage.Read.All` (channel attachments + history)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - `Chat.Read.All` or `ChatMessage.Read.All` (group chats)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **Grant admin consent** for the tenant.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Bump the Teams app **manifest version**, re-upload, and **reinstall the app in Teams**.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. **Fully quit and relaunch Teams** to clear cached app metadata.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Known Limitations（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Webhook timeouts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Teams delivers messages via HTTP webhook. If processing takes too long (e.g., slow LLM responses), you may see:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway timeouts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Teams retrying the message (causing duplicates)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Dropped replies（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw handles this by returning quickly and sending replies proactively, but very slow responses may still cause issues.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Formatting（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Teams markdown is more limited than Slack or Discord:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Basic formatting works: **bold**, _italic_, `code`, links（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Complex markdown (tables, nested lists) may not render correctly（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Adaptive Cards are supported for polls and arbitrary card sends (see below)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Configuration（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Key settings (see `/gateway/configuration` for shared channel patterns):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.msteams.enabled`: enable/disable the channel.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.msteams.appId`, `channels.msteams.appPassword`, `channels.msteams.tenantId`: bot credentials.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.msteams.webhook.port` (default `3978`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.msteams.webhook.path` (default `/api/messages`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.msteams.dmPolicy`: `pairing | allowlist | open | disabled` (default: pairing)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.msteams.allowFrom`: allowlist for DMs (AAD object IDs, UPNs, or display names). The wizard resolves names to IDs during setup when Graph access is available.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.msteams.textChunkLimit`: outbound text chunk size.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.msteams.chunkMode`: `length` (default) or `newline` to split on blank lines (paragraph boundaries) before length chunking.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.msteams.mediaAllowHosts`: allowlist for inbound attachment hosts (defaults to Microsoft/Teams domains).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.msteams.mediaAuthAllowHosts`: allowlist for attaching Authorization headers on media retries (defaults to Graph + Bot Framework hosts).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.msteams.requireMention`: require @mention in channels/groups (default true).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.msteams.replyStyle`: `thread | top-level` (see [Reply Style](#reply-style-threads-vs-posts)).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.msteams.teams.<teamId>.replyStyle`: per-team override.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.msteams.teams.<teamId>.requireMention`: per-team override.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.msteams.teams.<teamId>.tools`: default per-team tool policy overrides (`allow`/`deny`/`alsoAllow`) used when a channel override is missing.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.msteams.teams.<teamId>.toolsBySender`: default per-team per-sender tool policy overrides (`"*"` wildcard supported).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.msteams.teams.<teamId>.channels.<conversationId>.replyStyle`: per-channel override.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.msteams.teams.<teamId>.channels.<conversationId>.requireMention`: per-channel override.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.msteams.teams.<teamId>.channels.<conversationId>.tools`: per-channel tool policy overrides (`allow`/`deny`/`alsoAllow`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.msteams.teams.<teamId>.channels.<conversationId>.toolsBySender`: per-channel per-sender tool policy overrides (`"*"` wildcard supported).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.msteams.sharePointSiteId`: SharePoint site ID for file uploads in group chats/channels (see [Sending files in group chats](#sending-files-in-group-chats)).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Routing & Sessions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Session keys follow the standard agent format (see [/concepts/session](/concepts/session)):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Direct messages share the main session (`agent:<agentId>:<mainKey>`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Channel/group messages use conversation id:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - `agent:<agentId>:msteams:channel:<conversationId>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - `agent:<agentId>:msteams:group:<conversationId>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Reply Style: Threads vs Posts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Teams recently introduced two channel UI styles over the same underlying data model:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Style                    | Description                                               | Recommended `replyStyle` |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ------------------------ | --------------------------------------------------------- | ------------------------ |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Posts** (classic)      | Messages appear as cards with threaded replies underneath | `thread` (default)       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Threads** (Slack-like) | Messages flow linearly, more like Slack                   | `top-level`              |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**The problem:** The Teams API does not expose which UI style a channel uses. If you use the wrong `replyStyle`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `thread` in a Threads-style channel → replies appear nested awkwardly（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `top-level` in a Posts-style channel → replies appear as separate top-level posts instead of in-thread（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Solution:** Configure `replyStyle` per-channel based on how the channel is set up:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "msteams": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "replyStyle": "thread",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "teams": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "19:abc...@thread.tacv2": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "channels": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          "19:xyz...@thread.tacv2": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            "replyStyle": "top-level"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Attachments & Images（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Current limitations:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **DMs:** Images and file attachments work via Teams bot file APIs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Channels/groups:** Attachments live in M365 storage (SharePoint/OneDrive). The webhook payload only includes an HTML stub, not the actual file bytes. **Graph API permissions are required** to download channel attachments.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Without Graph permissions, channel messages with images will be received as text-only (the image content is not accessible to the bot).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
By default, OpenClaw only downloads media from Microsoft/Teams hostnames. Override with `channels.msteams.mediaAllowHosts` (use `["*"]` to allow any host).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Authorization headers are only attached for hosts in `channels.msteams.mediaAuthAllowHosts` (defaults to Graph + Bot Framework hosts). Keep this list strict (avoid multi-tenant suffixes).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Sending files in group chats（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Bots can send files in DMs using the FileConsentCard flow (built-in). However, **sending files in group chats/channels** requires additional setup:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Context                  | How files are sent                           | Setup needed                                    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ------------------------ | -------------------------------------------- | ----------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **DMs**                  | FileConsentCard → user accepts → bot uploads | Works out of the box                            |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Group chats/channels** | Upload to SharePoint → share link            | Requires `sharePointSiteId` + Graph permissions |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Images (any context)** | Base64-encoded inline                        | Works out of the box                            |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Why group chats need SharePoint（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Bots don't have a personal OneDrive drive (the `/me/drive` Graph API endpoint doesn't work for application identities). To send files in group chats/channels, the bot uploads to a **SharePoint site** and creates a sharing link.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Setup（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **Add Graph API permissions** in Entra ID (Azure AD) → App Registration:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - `Sites.ReadWrite.All` (Application) - upload files to SharePoint（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - `Chat.Read.All` (Application) - optional, enables per-user sharing links（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **Grant admin consent** for the tenant.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. **Get your SharePoint site ID:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   # Via Graph Explorer or curl with a valid token:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   curl -H "Authorization: Bearer $TOKEN" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
     "https://graph.microsoft.com/v1.0/sites/{hostname}:/{site-path}"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   # Example: for a site at "contoso.sharepoint.com/sites/BotFiles"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   curl -H "Authorization: Bearer $TOKEN" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
     "https://graph.microsoft.com/v1.0/sites/contoso.sharepoint.com:/sites/BotFiles"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   # Response includes: "id": "contoso.sharepoint.com,guid1,guid2"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. **Configure OpenClaw:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
     channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
       msteams: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
         // ... other config ...（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
         sharePointSiteId: "contoso.sharepoint.com,guid1,guid2",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
       },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
     },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Sharing behavior（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Permission                              | Sharing behavior                                          |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| --------------------------------------- | --------------------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `Sites.ReadWrite.All` only              | Organization-wide sharing link (anyone in org can access) |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `Sites.ReadWrite.All` + `Chat.Read.All` | Per-user sharing link (only chat members can access)      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Per-user sharing is more secure as only the chat participants can access the file. If `Chat.Read.All` permission is missing, the bot falls back to organization-wide sharing.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Fallback behavior（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Scenario                                          | Result                                             |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ------------------------------------------------- | -------------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Group chat + file + `sharePointSiteId` configured | Upload to SharePoint, send sharing link            |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Group chat + file + no `sharePointSiteId`         | Attempt OneDrive upload (may fail), send text only |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Personal chat + file                              | FileConsentCard flow (works without SharePoint)    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Any context + image                               | Base64-encoded inline (works without SharePoint)   |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Files stored location（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Uploaded files are stored in a `/OpenClawShared/` folder in the configured SharePoint site's default document library.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Polls (Adaptive Cards)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw sends Teams polls as Adaptive Cards (there is no native Teams poll API).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI: `openclaw message poll --channel msteams --target conversation:<id> ...`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Votes are recorded by the gateway in `~/.openclaw/msteams-polls.json`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The gateway must stay online to record votes.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Polls do not auto-post result summaries yet (inspect the store file if needed).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Adaptive Cards (arbitrary)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Send any Adaptive Card JSON to Teams users or conversations using the `message` tool or CLI.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The `card` parameter accepts an Adaptive Card JSON object. When `card` is provided, the message text is optional.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Agent tool:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "action": "send",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "channel": "msteams",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "target": "user:<id>",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "card": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "type": "AdaptiveCard",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "version": "1.5",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "body": [{ "type": "TextBlock", "text": "Hello!" }]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**CLI:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw message send --channel msteams \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --target "conversation:19:abc...@thread.tacv2" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --card '{"type":"AdaptiveCard","version":"1.5","body":[{"type":"TextBlock","text":"Hello!"}]}'（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See [Adaptive Cards documentation](https://adaptivecards.io/) for card schema and examples. For target format details, see [Target formats](#target-formats) below.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Target formats（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
MSTeams targets use prefixes to distinguish between users and conversations:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Target type         | Format                           | Example                                             |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ------------------- | -------------------------------- | --------------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| User (by ID)        | `user:<aad-object-id>`           | `user:40a1a0ed-4ff2-4164-a219-55518990c197`         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| User (by name)      | `user:<display-name>`            | `user:John Smith` (requires Graph API)              |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Group/channel       | `conversation:<conversation-id>` | `conversation:19:abc123...@thread.tacv2`            |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Group/channel (raw) | `<conversation-id>`              | `19:abc123...@thread.tacv2` (if contains `@thread`) |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**CLI examples:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Send to a user by ID（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw message send --channel msteams --target "user:40a1a0ed-..." --message "Hello"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Send to a user by display name (triggers Graph API lookup)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw message send --channel msteams --target "user:John Smith" --message "Hello"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Send to a group chat or channel（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw message send --channel msteams --target "conversation:19:abc...@thread.tacv2" --message "Hello"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Send an Adaptive Card to a conversation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw message send --channel msteams --target "conversation:19:abc...@thread.tacv2" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --card '{"type":"AdaptiveCard","version":"1.5","body":[{"type":"TextBlock","text":"Hello"}]}'（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Agent tool examples:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "action": "send",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "channel": "msteams",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "target": "user:John Smith",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "message": "Hello!"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "action": "send",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "channel": "msteams",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "target": "conversation:19:abc...@thread.tacv2",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "card": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "type": "AdaptiveCard",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "version": "1.5",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "body": [{ "type": "TextBlock", "text": "Hello" }]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Note: Without the `user:` prefix, names default to group/team resolution. Always use `user:` when targeting people by display name.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Proactive messaging（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Proactive messages are only possible **after** a user has interacted, because we store conversation references at that point.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- See `/gateway/configuration` for `dmPolicy` and allowlist gating.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Team and Channel IDs (Common Gotcha)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The `groupId` query parameter in Teams URLs is **NOT** the team ID used for configuration. Extract IDs from the URL path instead:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Team URL:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
https://teams.microsoft.com/l/team/19%3ABk4j...%40thread.tacv2/conversations?groupId=...（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
                                    └────────────────────────────┘（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
                                    Team ID (URL-decode this)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Channel URL:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
https://teams.microsoft.com/l/channel/19%3A15bc...%40thread.tacv2/ChannelName?groupId=...（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
                                      └─────────────────────────┘（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
                                      Channel ID (URL-decode this)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**For config:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Team ID = path segment after `/team/` (URL-decoded, e.g., `19:Bk4j...@thread.tacv2`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Channel ID = path segment after `/channel/` (URL-decoded)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Ignore** the `groupId` query parameter（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Private Channels（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Bots have limited support in private channels:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Feature                      | Standard Channels | Private Channels       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ---------------------------- | ----------------- | ---------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Bot installation             | Yes               | Limited                |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Real-time messages (webhook) | Yes               | May not work           |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| RSC permissions              | Yes               | May behave differently |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| @mentions                    | Yes               | If bot is accessible   |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Graph API history            | Yes               | Yes (with permissions) |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Workarounds if private channels don't work:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Use standard channels for bot interactions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Use DMs - users can always message the bot directly（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Use Graph API for historical access (requires `ChannelMessage.Read.All`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Troubleshooting（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Common issues（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Images not showing in channels:** Graph permissions or admin consent missing. Reinstall the Teams app and fully quit/reopen Teams.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **No responses in channel:** mentions are required by default; set `channels.msteams.requireMention=false` or configure per team/channel.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Version mismatch (Teams still shows old manifest):** remove + re-add the app and fully quit Teams to refresh.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **401 Unauthorized from webhook:** Expected when testing manually without Azure JWT - means endpoint is reachable but auth failed. Use Azure Web Chat to test properly.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Manifest upload errors（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **"Icon file cannot be empty":** The manifest references icon files that are 0 bytes. Create valid PNG icons (32x32 for `outline.png`, 192x192 for `color.png`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **"webApplicationInfo.Id already in use":** The app is still installed in another team/chat. Find and uninstall it first, or wait 5-10 minutes for propagation.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **"Something went wrong" on upload:** Upload via [https://admin.teams.microsoft.com](https://admin.teams.microsoft.com) instead, open browser DevTools (F12) → Network tab, and check the response body for the actual error.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Sideload failing:** Try "Upload an app to your org's app catalog" instead of "Upload a custom app" - this often bypasses sideload restrictions.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### RSC permissions not working（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Verify `webApplicationInfo.id` matches your bot's App ID exactly（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Re-upload the app and reinstall in the team/chat（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Check if your org admin has blocked RSC permissions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Confirm you're using the right scope: `ChannelMessage.Read.Group` for teams, `ChatMessage.Read.Chat` for group chats（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## References（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Create Azure Bot](https://learn.microsoft.com/en-us/azure/bot-service/bot-service-quickstart-registration) - Azure Bot setup guide（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Teams Developer Portal](https://dev.teams.microsoft.com/apps) - create/manage Teams apps（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Teams app manifest schema](https://learn.microsoft.com/en-us/microsoftteams/platform/resources/schema/manifest-schema)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Receive channel messages with RSC](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/channel-messages-with-rsc)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [RSC permissions reference](https://learn.microsoft.com/en-us/microsoftteams/platform/graph-api/rsc/resource-specific-consent)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Teams bot file handling](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/bots-filesv4) (channel/group requires Graph)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Proactive messaging](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/send-proactive-messages)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
