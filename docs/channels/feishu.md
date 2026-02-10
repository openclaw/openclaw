---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Feishu bot overview, features, and configuration"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want to connect a Feishu/Lark bot（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You are configuring the Feishu channel（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: Feishu（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Feishu bot（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Feishu (Lark) is a team chat platform used by companies for messaging and collaboration. This plugin connects OpenClaw to a Feishu/Lark bot using the platform’s WebSocket event subscription so messages can be received without exposing a public webhook URL.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Plugin required（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Install the Feishu plugin:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw plugins install @openclaw/feishu（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Local checkout (when running from a git repo):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw plugins install ./extensions/feishu（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Quickstart（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
There are two ways to add the Feishu channel:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Method 1: onboarding wizard (recommended)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you just installed OpenClaw, run the wizard:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw onboard（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The wizard guides you through:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Creating a Feishu app and collecting credentials（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Configuring app credentials in OpenClaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Starting the gateway（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
✅ **After configuration**, check gateway status:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw gateway status`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw logs --follow`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Method 2: CLI setup（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you already completed initial install, add the channel via CLI:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw channels add（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Choose **Feishu**, then enter the App ID and App Secret.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
✅ **After configuration**, manage the gateway:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw gateway status`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw gateway restart`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw logs --follow`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Step 1: Create a Feishu app（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 1. Open Feishu Open Platform（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Visit [Feishu Open Platform](https://open.feishu.cn/app) and sign in.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Lark (global) tenants should use [https://open.larksuite.com/app](https://open.larksuite.com/app) and set `domain: "lark"` in the Feishu config.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 2. Create an app（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Click **Create enterprise app**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Fill in the app name + description（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Choose an app icon（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
![Create enterprise app](../images/feishu-step2-create-app.png)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 3. Copy credentials（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
From **Credentials & Basic Info**, copy:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **App ID** (format: `cli_xxx`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **App Secret**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
❗ **Important:** keep the App Secret private.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
![Get credentials](../images/feishu-step3-credentials.png)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 4. Configure permissions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
On **Permissions**, click **Batch import** and paste:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "scopes": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "tenant": [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "aily:file:read",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "aily:file:write",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "application:application.app_message_stats.overview:readonly",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "application:application:self_manage",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "application:bot.menu:write",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "contact:user.employee_id:readonly",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "corehr:file:download",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "event:ip_list",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "im:chat.access_event.bot_p2p_chat:read",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "im:chat.members:bot_access",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "im:message",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "im:message.group_at_msg:readonly",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "im:message.p2p_msg:readonly",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "im:message:readonly",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "im:message:send_as_bot",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "im:resource"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "user": ["aily:file:read", "aily:file:write", "im:chat.access_event.bot_p2p_chat:read"]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
![Configure permissions](../images/feishu-step4-permissions.png)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 5. Enable bot capability（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
In **App Capability** > **Bot**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Enable bot capability（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Set the bot name（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
![Enable bot capability](../images/feishu-step5-bot-capability.png)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 6. Configure event subscription（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
⚠️ **Important:** before setting event subscription, make sure:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. You already ran `openclaw channels add` for Feishu（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. The gateway is running (`openclaw gateway status`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
In **Event Subscription**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Choose **Use long connection to receive events** (WebSocket)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Add the event: `im.message.receive_v1`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
⚠️ If the gateway is not running, the long-connection setup may fail to save.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
![Configure event subscription](../images/feishu-step6-event-subscription.png)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 7. Publish the app（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Create a version in **Version Management & Release**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Submit for review and publish（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Wait for admin approval (enterprise apps usually auto-approve)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Step 2: Configure OpenClaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Configure with the wizard (recommended)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw channels add（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Choose **Feishu** and paste your App ID + App Secret.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Configure via config file（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Edit `~/.openclaw/openclaw.json`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    feishu: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      enabled: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      dmPolicy: "pairing",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      accounts: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        main: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          appId: "cli_xxx",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          appSecret: "xxx",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          botName: "My AI assistant",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Configure via environment variables（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
export FEISHU_APP_ID="cli_xxx"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
export FEISHU_APP_SECRET="xxx"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Lark (global) domain（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If your tenant is on Lark (international), set the domain to `lark` (or a full domain string). You can set it at `channels.feishu.domain` or per account (`channels.feishu.accounts.<id>.domain`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    feishu: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      domain: "lark",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      accounts: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        main: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          appId: "cli_xxx",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          appSecret: "xxx",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Step 3: Start + test（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 1. Start the gateway（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 2. Send a test message（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
In Feishu, find your bot and send a message.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 3. Approve pairing（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
By default, the bot replies with a pairing code. Approve it:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw pairing approve feishu <CODE>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
After approval, you can chat normally.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Overview（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Feishu bot channel**: Feishu bot managed by the gateway（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Deterministic routing**: replies always return to Feishu（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Session isolation**: DMs share a main session; groups are isolated（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **WebSocket connection**: long connection via Feishu SDK, no public URL needed（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Access control（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Direct messages（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Default**: `dmPolicy: "pairing"` (unknown users get a pairing code)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Approve pairing**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  openclaw pairing list feishu（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  openclaw pairing approve feishu <CODE>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Allowlist mode**: set `channels.feishu.allowFrom` with allowed Open IDs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Group chats（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**1. Group policy** (`channels.feishu.groupPolicy`):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `"open"` = allow everyone in groups (default)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `"allowlist"` = only allow `groupAllowFrom`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `"disabled"` = disable group messages（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**2. Mention requirement** (`channels.feishu.groups.<chat_id>.requireMention`):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `true` = require @mention (default)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `false` = respond without mentions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Group configuration examples（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Allow all groups, require @mention (default)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    feishu: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      groupPolicy: "open",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      // Default requireMention: true（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Allow all groups, no @mention required（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    feishu: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      groups: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        oc_xxx: { requireMention: false },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Allow specific users in groups only（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    feishu: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      groupPolicy: "allowlist",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      groupAllowFrom: ["ou_xxx", "ou_yyy"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Get group/user IDs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Group IDs (chat_id)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Group IDs look like `oc_xxx`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Method 1 (recommended)**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Start the gateway and @mention the bot in the group（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Run `openclaw logs --follow` and look for `chat_id`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Method 2**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use the Feishu API debugger to list group chats.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### User IDs (open_id)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
User IDs look like `ou_xxx`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Method 1 (recommended)**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Start the gateway and DM the bot（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Run `openclaw logs --follow` and look for `open_id`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Method 2**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Check pairing requests for user Open IDs:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw pairing list feishu（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Common commands（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Command   | Description       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| --------- | ----------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `/status` | Show bot status   |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `/reset`  | Reset the session |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `/model`  | Show/switch model |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
> Note: Feishu does not support native command menus yet, so commands must be sent as text.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Gateway management commands（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Command                    | Description                   |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| -------------------------- | ----------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `openclaw gateway status`  | Show gateway status           |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `openclaw gateway install` | Install/start gateway service |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `openclaw gateway stop`    | Stop gateway service          |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `openclaw gateway restart` | Restart gateway service       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `openclaw logs --follow`   | Tail gateway logs             |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Troubleshooting（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Bot does not respond in group chats（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Ensure the bot is added to the group（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Ensure you @mention the bot (default behavior)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Check `groupPolicy` is not set to `"disabled"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Check logs: `openclaw logs --follow`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Bot does not receive messages（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Ensure the app is published and approved（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Ensure event subscription includes `im.message.receive_v1`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Ensure **long connection** is enabled（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Ensure app permissions are complete（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
5. Ensure the gateway is running: `openclaw gateway status`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
6. Check logs: `openclaw logs --follow`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### App Secret leak（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Reset the App Secret in Feishu Open Platform（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Update the App Secret in your config（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Restart the gateway（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Message send failures（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Ensure the app has `im:message:send_as_bot` permission（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Ensure the app is published（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Check logs for detailed errors（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Advanced configuration（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Multiple accounts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    feishu: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      accounts: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        main: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          appId: "cli_xxx",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          appSecret: "xxx",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          botName: "Primary bot",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        backup: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          appId: "cli_yyy",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          appSecret: "yyy",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          botName: "Backup bot",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          enabled: false,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Message limits（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `textChunkLimit`: outbound text chunk size (default: 2000 chars)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `mediaMaxMb`: media upload/download limit (default: 30MB)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Streaming（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Feishu supports streaming replies via interactive cards. When enabled, the bot updates a card as it generates text.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    feishu: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      streaming: true, // enable streaming card output (default true)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      blockStreaming: true, // enable block-level streaming (default true)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Set `streaming: false` to wait for the full reply before sending.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Multi-agent routing（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use `bindings` to route Feishu DMs or groups to different agents.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    list: [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      { id: "main" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        id: "clawd-fan",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        workspace: "/home/user/clawd-fan",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        agentDir: "/home/user/.openclaw/agents/clawd-fan/agent",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        id: "clawd-xi",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        workspace: "/home/user/clawd-xi",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        agentDir: "/home/user/.openclaw/agents/clawd-xi/agent",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  bindings: [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      agentId: "main",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      match: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        channel: "feishu",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        peer: { kind: "direct", id: "ou_xxx" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      agentId: "clawd-fan",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      match: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        channel: "feishu",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        peer: { kind: "direct", id: "ou_yyy" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      agentId: "clawd-xi",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      match: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        channel: "feishu",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        peer: { kind: "group", id: "oc_zzz" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Routing fields:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `match.channel`: `"feishu"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `match.peer.kind`: `"direct"` or `"group"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `match.peer.id`: user Open ID (`ou_xxx`) or group ID (`oc_xxx`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See [Get group/user IDs](#get-groupuser-ids) for lookup tips.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Configuration reference（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Full configuration: [Gateway configuration](/gateway/configuration)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Key options:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Setting                                           | Description                     | Default   |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ------------------------------------------------- | ------------------------------- | --------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `channels.feishu.enabled`                         | Enable/disable channel          | `true`    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `channels.feishu.domain`                          | API domain (`feishu` or `lark`) | `feishu`  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `channels.feishu.accounts.<id>.appId`             | App ID                          | -         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `channels.feishu.accounts.<id>.appSecret`         | App Secret                      | -         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `channels.feishu.accounts.<id>.domain`            | Per-account API domain override | `feishu`  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `channels.feishu.dmPolicy`                        | DM policy                       | `pairing` |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `channels.feishu.allowFrom`                       | DM allowlist (open_id list)     | -         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `channels.feishu.groupPolicy`                     | Group policy                    | `open`    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `channels.feishu.groupAllowFrom`                  | Group allowlist                 | -         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `channels.feishu.groups.<chat_id>.requireMention` | Require @mention                | `true`    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `channels.feishu.groups.<chat_id>.enabled`        | Enable group                    | `true`    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `channels.feishu.textChunkLimit`                  | Message chunk size              | `2000`    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `channels.feishu.mediaMaxMb`                      | Media size limit                | `30`      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `channels.feishu.streaming`                       | Enable streaming card output    | `true`    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `channels.feishu.blockStreaming`                  | Enable block streaming          | `true`    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## dmPolicy reference（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Value         | Behavior                                                        |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ------------- | --------------------------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `"pairing"`   | **Default.** Unknown users get a pairing code; must be approved |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `"allowlist"` | Only users in `allowFrom` can chat                              |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `"open"`      | Allow all users (requires `"*"` in allowFrom)                   |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `"disabled"`  | Disable DMs                                                     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Supported message types（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Receive（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- ✅ Text（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- ✅ Rich text (post)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- ✅ Images（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- ✅ Files（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- ✅ Audio（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- ✅ Video（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- ✅ Stickers（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Send（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- ✅ Text（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- ✅ Images（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- ✅ Files（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- ✅ Audio（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- ⚠️ Rich text (partial support)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
