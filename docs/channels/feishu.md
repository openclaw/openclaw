---
summary: "Feishu (Lark) bot support, capabilities, and configuration"
read_when:
  - Working on Feishu features
  - Integrating with Chinese enterprise messaging
---
# Feishu (飞书/Lark)

Status: experimental. Supports direct messages and groups via Bot API using WebSocket long connection.

## Plugin required
Feishu ships as a plugin and is not bundled with the core install.
- Install via CLI: `clawdbot plugins install @clawdbot/feishu`
- Or select **Feishu** during onboarding and confirm the install prompt
- Details: [Plugins](/plugin)

## Quick setup (beginner)
1) Install the Feishu plugin:
   - From a source checkout: `clawdbot plugins install ./extensions/feishu`
   - From npm (if published): `clawdbot plugins install @clawdbot/feishu`
   - Or pick **Feishu** in onboarding and confirm the install prompt
2) Create an app in Feishu Open Platform and get App ID + App Secret
3) Set the credentials:
   - Env: `FEISHU_APP_ID=...` and `FEISHU_APP_SECRET=...`
   - Or config: `channels.feishu.appId` and `channels.feishu.appSecret`
4) Configure event subscription in Feishu console:
   - Set subscription method to **"Long Connection"**
   - Add `im.message.receive_v1` event
5) Restart the gateway (or finish onboarding)
6) DM access is pairing by default; approve the pairing code on first contact

Minimal config:
```json5
{
  channels: {
    feishu: {
      enabled: true,
      appId: "cli_xxxxxxxxxx",
      appSecret: "xxxxxxxxxxxxxxxxxxxxxxxx",
      dmPolicy: "pairing"
    }
  }
}
```

## What it is
Feishu (飞书) is an enterprise collaboration platform by ByteDance, also known as Lark internationally. Its Bot API allows the Gateway to run a bot for 1:1 conversations and group chats.
- A Feishu Bot API channel owned by the Gateway
- Uses WebSocket long connection for receiving events (no public IP needed)
- Deterministic routing: replies go back to Feishu; the model never chooses channels
- DMs share the agent's main session
- Groups require @mention by default

## Setup (fast path)

### 1) Create an app in Feishu Open Platform
1) Go to **https://open.feishu.cn/app** and sign in
2) Click "Create App" and choose "Enterprise Self-built App"
3) Fill in the basic information (name, description, icon)
4) Add **Bot** capability in "Add Application Capabilities"
5) Go to "Credentials and Basic Info" to get your **App ID** and **App Secret**

### 2) Configure permissions
1) Go to "Permission Management" in your app
2) Add at least these permissions:
   - `im:message` - Send messages
   - `im:message.receive_v1` - Receive messages (event subscription)
   - `im:chat` - Access chat information
   - `contact:user.id:readonly` - Read user info (optional, for name display)
3) Request approval if required by your organization

### 3) Configure event subscription
1) Go to "Events and Callbacks" page
2) Set subscription method to **"Long Connection"** (WebSocket)
3) Add event subscription: `im.message.receive_v1` (Receive messages)
4) Click Save

### 4) Configure the token (env or config)
Example:

```json5
{
  channels: {
    feishu: {
      enabled: true,
      appId: "cli_xxxxxxxxxx",
      appSecret: "xxxxxxxxxxxxxxxxxxxxxxxx",
      dmPolicy: "pairing"
    }
  }
}
```

Env option (works for the default account only):
- `FEISHU_APP_ID=cli_xxxxxxxxxx`
- `FEISHU_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxx`

Multi-account support: use `channels.feishu.accounts` with per-account credentials and optional `name`.

### 5) Publish the app
1) Go to "Version Management and Release"
2) Create a new version
3) Submit for review (or use within your organization if no review required)
4) Once approved, the bot is ready to use

### 6) Start the gateway
Restart the gateway. Feishu starts when credentials are resolved.
DM access defaults to pairing. Approve the code when the bot is first contacted.

## How it works (behavior)
- The gateway establishes a WebSocket long connection to Feishu servers
- Events are pushed directly through the WebSocket (no public IP needed)
- Messages are normalized into the shared channel envelope
- Replies always route back to the same Feishu chat
- Long responses are chunked to 4000 characters (Feishu API limit)

## Limits
- Outbound text is chunked to 4000 characters (Feishu API limit)
- Media downloads/uploads are capped by `channels.feishu.mediaMaxMb` (default 20)
- Rate limits apply per the Feishu API documentation

## Access control (DMs)

### DM access
- Default: `channels.feishu.dmPolicy = "pairing"`. Unknown senders receive a pairing code; messages are ignored until approved (codes expire after 1 hour)
- Approve via:
  - `clawdbot pairing list feishu`
  - `clawdbot pairing approve feishu <CODE>`
- Pairing is the default token exchange. Details: [Pairing](/start/pairing)
- `channels.feishu.allowFrom` accepts Feishu user IDs (open_id like `ou_xxx` or user_id)

### Group access
- Default: `channels.feishu.groupPolicy = "allowlist"`. Only groups in the allowlist receive responses
- Configure allowed groups via `channels.feishu.groupAllowFrom` or `channels.feishu.groups`
- Groups require @mention by default; configure per-group via `channels.feishu.groups.<chat_id>.requireMention`

## Supported message types
- **Interactive cards**: Full markdown support via card messages (default for replies)
- **Text messages**: Plain text fallback
- **Image messages**: Requires image_key (pre-uploaded images)
- **Rich text (post)**: Planned support

### Markdown support
All outbound messages use Feishu interactive card format, which supports markdown syntax:
- **Bold**: `**text**`
- *Italic*: `*text*`
- ~~Strikethrough~~: `~~text~~`
- `Code`: `` `code` ``
- Links: `[text](url)`
- Lists and more

## Capabilities
| Feature | Status |
|---------|--------|
| Direct messages | Supported |
| Groups | Supported |
| Markdown formatting | Supported (via card messages) |
| Media (images) | Partial (requires image_key) |
| Reactions | Not supported |
| Threads | Not supported |
| Polls | Not supported |
| Native commands | Not supported |
| Streaming | Blocked |

## Delivery targets (CLI/cron)
- Use an open_id, user_id, or chat_id as the target
- Example: `clawdbot message send --channel feishu --target ou_xxxxxxxxxx --message "hi"`
- For groups: `clawdbot message send --channel feishu --target oc_xxxxxxxxxx --message "hi"`

## Troubleshooting

**Bot does not respond:**
- Check that the app credentials are valid: `clawdbot channels status --probe`
- Verify the event subscription is set to "Long Connection" mode in Feishu console
- Verify the sender is approved (pairing or allowFrom)
- Check gateway logs: `clawdbot logs --follow`

**WebSocket connection fails:**
- Ensure the gateway has network access to Feishu servers
- Check that the App ID and App Secret are correct
- Verify the app is published and active

**Permission errors:**
- Ensure the app has required permissions (`im:message`, `im:message.receive_v1`)
- Check if permissions need admin approval in your organization
- Verify the app is published and active

**Cannot send messages:**
- Check that the bot has been added to the chat (for groups)
- Verify the target ID format (open_id starts with `ou_`, chat_id starts with `oc_`)
- Check API quota limits

## Configuration reference (Feishu)
Full configuration: [Configuration](/gateway/configuration)

Provider options:
- `channels.feishu.enabled`: enable/disable channel startup
- `channels.feishu.appId`: App ID from Feishu Open Platform
- `channels.feishu.appSecret`: App Secret from Feishu Open Platform
- `channels.feishu.appSecretFile`: read app secret from file path
- `channels.feishu.dmPolicy`: `pairing | allowlist | open | disabled` (default: pairing)
- `channels.feishu.allowFrom`: DM allowlist (open_id or user_id). `open` requires `"*"`
- `channels.feishu.groupPolicy`: `open | allowlist` (default: allowlist)
- `channels.feishu.groupAllowFrom`: group allowlist (chat_id)
- `channels.feishu.groups`: per-group configuration
- `channels.feishu.mediaMaxMb`: inbound/outbound media cap (MB, default 20)

Multi-account options:
- `channels.feishu.accounts.<id>.appId`: per-account App ID
- `channels.feishu.accounts.<id>.appSecret`: per-account App Secret
- `channels.feishu.accounts.<id>.appSecretFile`: per-account secret file
- `channels.feishu.accounts.<id>.name`: display name
- `channels.feishu.accounts.<id>.enabled`: enable/disable account
- `channels.feishu.accounts.<id>.dmPolicy`: per-account DM policy
- `channels.feishu.accounts.<id>.allowFrom`: per-account allowlist

## International users (Lark)
For Lark (international version), use the same configuration. The API endpoints are compatible.
Consider using `lark` or `fs` as channel aliases in CLI commands:
- `clawdbot message send --channel lark --target ou_xxx --message "hi"`
