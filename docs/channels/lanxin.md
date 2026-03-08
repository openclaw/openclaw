---
summary: "Lanxin bot overview, features, and configuration"
read_when:
  - You want to connect a Lanxin bot
  - You are configuring the Lanxin channel
title: Lanxin
---

# Lanxin bot

Lanxin is an instant messaging platform built for government agencies, state-owned enterprises, and large organizations in China, serving over 8,000 enterprises. The OpenClaw Lanxin plugin connects via Lanxin Open Platform callback + message API, enabling DM/group messaging and media file sending.

Current features:

- DM and group message receiving
- Text sending
- Image/file/video upload and sending
- Callback decryption (`dataEncrypt`)
- Event ID deduplication (prevents duplicate processing from platform retries)
- DM/group policies (`dmPolicy`/`groupPolicy`)

---

## Plugin required

Install the Lanxin plugin:

```bash
openclaw plugins install @openclaw/lanxin
```

Local checkout (when running from a git repo):

```bash
openclaw plugins install ./extensions/lanxin
```

---

## Quickstart

There are two ways to add the Lanxin channel:

### Method 1: onboarding wizard (recommended)

If you just installed OpenClaw, run the wizard:

```bash
openclaw onboard
```

The wizard guides you through:

1. Creating a Lanxin app and collecting credentials
2. Configuring app credentials in OpenClaw
3. Starting the gateway

Or add the channel directly:

```bash
openclaw channels add
```

Choose **Lanxin**, then enter:

1. API base URL
2. App ID
3. App Secret
4. AES Key (for decrypting platform callbacks)
5. Optional `defaultEntryId` (fallback for proactive messages)

✅ **After configuration**, check gateway status:

- `openclaw gateway status` - View gateway status
- `openclaw logs --follow` - View real-time logs

### Method 2: config file setup

Edit `~/.openclaw/openclaw.json`:

```json5
{
  channels: {
    lanxin: {
      enabled: true,
      name: "Enterprise Assistant",
      appId: "xxxxxxx-xxxxxxx",
      appSecret: "xxxxxxxxxxxxxxxx",
      aesKey: "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      apiBaseUrl: "https://x.e.lanxin.cn/open/apigw/v1/",
      webhookHost: "0.0.0.0",
      webhookPort: 8789,
      webhookPath: "/lanxin/callback",
      dmPolicy: "pairing",
      groupPolicy: "allowlist",
      allowFrom: [],
      groupAllowFrom: [],
      // Optional: fallback when proactive messages lack entryId
      defaultEntryId: "alpha-xxxx",
      // Optional: debug logging
      debug: false,
    },
  },
}
```

### Configuration reference

| Setting          | Required | Default                                | Description                                     |
| ---------------- | -------- | -------------------------------------- | ----------------------------------------------- |
| `enabled`        | No       | `false`                                | Enable the Lanxin channel                       |
| `appId`          | Yes      | -                                      | Lanxin App ID                                   |
| `appSecret`      | Yes      | -                                      | Lanxin App Secret                               |
| `aesKey`         | Yes      | -                                      | Decryption key for callback `dataEncrypt`       |
| `apiBaseUrl`     | No       | `https://x.e.lanxin.cn/open/apigw/v1/` | Lanxin Open Platform API base URL               |
| `webhookHost`    | No       | `0.0.0.0`                              | Callback bind address                           |
| `webhookPort`    | No       | `8789`                                 | Callback bind port                              |
| `webhookPath`    | No       | `/lanxin/callback`                     | Callback route path                             |
| `dmPolicy`       | No       | `pairing`                              | DM policy: `open/pairing/allowlist/disabled`    |
| `groupPolicy`    | No       | `allowlist` (recommended)              | Group policy: `open/allowlist/disabled`         |
| `allowFrom`      | No       | `[]`                                   | DM allowlist                                    |
| `groupAllowFrom` | No       | `[]`                                   | Group allowlist                                 |
| `defaultEntryId` | No       | -                                      | Fallback when proactive messages lack `entryId` |
| `debug`          | No       | `false`                                | Enable Lanxin debug logging                     |

---

## Step 1: Create a Lanxin app

### 1. Open Lanxin Open Platform

Visit the Lanxin admin console (URL depends on your enterprise deployment) and sign in with your Lanxin account.

### 2. Create an app

1. Go to **App Center** and click **App Management**
2. Click **Create App**
3. Fill in the app name and description
4. Choose an app icon

### 3. Get app credentials

On the app details page, click **Go to Developer Center** and copy:

- **App ID** (application identifier)
- **App Secret** (application secret)
- **AES Key** (encryption key for decrypting callback messages)

❗ **Important:** keep the App Secret and AES Key private. Do not share or commit to public repositories.

### 4. Enable bot capability

1. On the app's **Self-built App Development** page, click **Smart Bot** capability
2. Enable the bot service and configure the bot name and avatar

### 5. Configure callback permissions

On the app's **Callback Events** page, enable the following permissions:

- Bot DM reply (send reply messages to users)
- Bot group message reply (send reply messages to groups)
- User info read permission (optional, for getting sender names)

### 6. Configure event subscription (callback URL)

⚠️ **Important:** before configuring the callback URL, ensure:

1. You have completed OpenClaw channel configuration (`openclaw channels add`)
2. The gateway is running (`openclaw gateway status`)
3. The callback URL is publicly accessible

On the app's **Callback Events** page:

1. Enter the callback URL:

   `https://<your-domain>/lanxin/callback`

2. Subscribe to required events (e.g., DM messages, group messages)
3. Save the configuration

The platform will POST to your URL, which may include query parameters:

```text
https://<your-domain>/lanxin/callback?timestamp=...&nonce=...&signature=...
```

### 7. Publish the app

1. Publish on the **App Release** page
2. Submit for review and wait for admin approval

---

## Step 2: Configure OpenClaw

### Configure with the wizard (recommended)

Run the following command and enter credentials when prompted:

```bash
openclaw channels add
```

Choose **Lanxin**, then enter:

1. API base URL
2. App ID
3. App Secret
4. AES Key (for decrypting callback messages)
5. Optional: default Entry ID (for proactive messages)

### Configure via config file

Edit `~/.openclaw/openclaw.json`:

```json5
{
  channels: {
    lanxin: {
      enabled: true,
      name: "Enterprise Assistant",
      appId: "xxxxxxx-xxxxxxx",
      appSecret: "xxxxxxxxxxxxxxxx",
      aesKey: "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      apiBaseUrl: "https://x.e.lanxin.cn/open/apigw/v1/",
      webhookHost: "0.0.0.0",
      webhookPort: 8789,
      webhookPath: "/lanxin/callback",
      dmPolicy: "pairing",
      groupPolicy: "allowlist",
      allowFrom: [],
      groupAllowFrom: [],
      // Optional: fallback when proactive messages lack entryId
      defaultEntryId: "alpha-xxxx",
      // Optional: debug logging
      debug: false,
    },
  },
}
```

### Configure via environment variables

```bash
export LANXIN_APP_ID="xxxxxxx-xxxxxxx"
export LANXIN_APP_SECRET="xxxxxxxxxxxxxxxx"
export LANXIN_AES_KEY="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

---

## Step 3: Start and test

### 1. Start the gateway

```bash
openclaw gateway run
```

It's recommended to also view logs:

```bash
openclaw logs --follow
```

### 2. Send a test message

In Lanxin, find the bot you created and send a message.

### 3. Approve pairing

By default (`dmPolicy: "pairing"`), the bot replies with a **pairing code**. You need to approve this code:

```bash
openclaw pairing approve lanxin <CODE>
```

After approval, you can chat normally.

### 4. Verification checklist

- ✅ Send text to the Lanxin bot in DM, confirm OpenClaw replies
- ✅ Send an image in Lanxin, confirm the bot can handle media messages
- ✅ Send a message in a Lanxin group, confirm the policy works (allowed or blocked)

✅ **After configuration**, manage the gateway:

- `openclaw gateway status` - View gateway status
- `openclaw gateway restart` - Restart gateway to apply new config
- `openclaw logs --follow` - View real-time logs

---

## Callback and retry mechanism

Lanxin event callbacks retry on timeout or failure, with typical intervals:

- ~5 minutes after first failure
- ~1 hour after second failure
- ~6 hours after third failure

The platform expects apps to return results within 3 seconds.

### How OpenClaw handles this

The Lanxin plugin:

1. Returns `200` as quickly as possible (to avoid platform marking as failed)
2. Persists deduplication based on `events[].id`
3. Only processes events that appear for the first time

This prevents duplicate replies from platform retries.

---

## Callback payload format (overview)

Callback request body (before decryption):

```json
{
  "dataEncrypt": "XXXXXXXX"
}
```

Key fields after decryption (example):

```json
{
  "events": [
    {
      "id": "event-id",
      "type": "bot_person_message",
      "data": {
        "entryId": "alpha-xxx",
        "msgId": "msg-xxx",
        "msgType": "text",
        "msgData": { "text": { "content": "hello" } }
      }
    }
  ]
}
```

---

## Message target format

Lanxin sending supports the following `target` formats:

- DM standard: `user:<userId>:<entryId>`
- DM shorthand: `<userId>:<entryId>`
- Group: `group:<groupId>:<entryId>`

Notes:

- `entryId` is a key parameter for sending messages
- If `entryId` is missing for proactive messages, use `channels.lanxin.defaultEntryId` as fallback

---

## Media handling

### Sending media

When sending media, the plugin flow:

1. Reads `mediaUrl` (local path or remote URL)
2. Uploads to `medias/create` to get `mediaId`
3. Calls the send API with `mediaType/mediaIds`

Current compatibility strategy: media sending uses `msgType=text` with `mediaType/mediaIds` in `msgData.text` (consistent with common Lanxin Python client behavior).

### Receiving media

When receiving callbacks with `mediaIds`, the plugin:

1. Calls `medias/{mediaId}/fetch` to download the file
2. Saves to the inbound media path
3. Injects `MediaPath/MediaPaths` into context
4. Adds structured attachment hints for the agent (type, count, contentType)

---

## Access control

### Direct messages

- **Default**: `dmPolicy: "pairing"`, unknown users receive a pairing code
- **Approve pairing**:

```bash
openclaw pairing list lanxin      # View pending approvals
openclaw pairing approve lanxin <CODE>  # Approve
```

- **Allowlist mode**: configure allowed user IDs via `channels.lanxin.allowFrom`

### Group access

**Group policy** (`channels.lanxin.groupPolicy`):

- `"open"` = allow all groups
- `"allowlist"` = only allow groups in `groupAllowFrom` (recommended)
- `"disabled"` = disable group messages

---

## Policy configuration

### DM policy (`dmPolicy`)

| Value         | Behavior                                                                     |
| ------------- | ---------------------------------------------------------------------------- |
| `"pairing"`   | **Default.** Unknown users receive a pairing code; must be approved by admin |
| `"allowlist"` | Only users in `allowFrom` can chat; others are silently ignored              |
| `"open"`      | Allow all users (requires `"*"` in allowFrom)                                |
| `"disabled"`  | Disable DMs completely                                                       |

### Group policy (`groupPolicy`)

| Value         | Behavior                                    |
| ------------- | ------------------------------------------- |
| `"open"`      | Allow all groups                            |
| `"allowlist"` | Only groups in `groupAllowFrom` can trigger |
| `"disabled"`  | Disable group messages                      |

Recommended for production:

- `dmPolicy: "pairing"`
- `groupPolicy: "allowlist"`

### Group configuration examples

#### Allow specific groups only

```json5
{
  channels: {
    lanxin: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["group-id-1", "group-id-2"],
    },
  },
}
```

---

## Common commands

| Command   | Description                |
| --------- | -------------------------- |
| `/status` | View bot status            |
| `/reset`  | Reset conversation session |
| `/model`  | View/switch model          |

## Gateway management commands

| Command                    | Description                   |
| -------------------------- | ----------------------------- |
| `openclaw gateway status`  | View gateway status           |
| `openclaw gateway install` | Install/start gateway service |
| `openclaw gateway stop`    | Stop gateway service          |
| `openclaw gateway restart` | Restart gateway service       |
| `openclaw logs --follow`   | View real-time logs           |

---

## Debugging and logging

Enable debug logging (choose one):

- Environment variable: `OPENCLAW_LANXIN_DEBUG=1`
- Config setting: `channels.lanxin.debug=true`

Key log messages:

- `upload media start/success`
- `HTTP POST start/response/parsed body`
- `webhook decrypted events`
- `skip duplicated event`

### Log troubleshooting reference

| Log keyword                     | Meaning                       | Check                                                    |
| ------------------------------- | ----------------------------- | -------------------------------------------------------- |
| `HTTP POST ... status: 401/403` | Authentication failed         | `appId/appSecret`, token expiration                      |
| `errCode != 0`                  | Platform business error       | Check `errMsg` and request fields (especially `entryId`) |
| `Invalid Lanxin target`         | Incorrect send target format  | Use `user:<userId>:<entryId>` or `<userId>:<entryId>`    |
| `Missing dataEncrypt`           | Unexpected callback body      | Platform callback URL/request body format                |
| `failed downloading media`      | Inbound media download failed | Check if `mediaId` is valid, token permissions           |
| `skip duplicated event`         | Deduplication hit             | Normal behavior (platform retry)                         |

---

## Troubleshooting

### Callback 404 / platform verification failed

1. Check if `webhookPath` matches platform configuration
2. Check if reverse proxy is rewriting the path
3. Check if callback URL is publicly accessible via HTTPS
4. Check if gateway is running: `openclaw gateway status`
5. View real-time logs: `openclaw logs --follow`

### Bot doesn't receive messages

1. Check if app is published and approved
2. Check if event subscription/callback configuration is correct
3. Check if app permissions are complete
4. Check if gateway is running
5. Check logs for incoming callback requests

### Receives messages but doesn't reply

1. Check if `dmPolicy/groupPolicy` is blocking
2. Check if `allowFrom/groupAllowFrom` includes the sender
3. Check if deduplication hit (log shows `skip duplicated event`)
4. Check logs for parsing errors or send exceptions

### Media upload succeeds but message doesn't display

Enable debug (`channels.lanxin.debug=true`) and check:

1. Is the `mediaId` from upload valid?
2. What's the `errCode/errMsg` from `bot/messages/create`?
3. Does `target` contain a valid `entryId`?

### Invalid Lanxin target

Supported target formats:

- `user:<userId>:<entryId>` (DM standard format)
- `<userId>:<entryId>` (DM shorthand format)
- `group:<groupId>:<entryId>` (group format)

If sending proactively without `entryId`, configure `defaultEntryId`.

### App Secret leaked

1. Reset App Secret in Lanxin Open Platform
2. Update App Secret in config file
3. Restart gateway: `openclaw gateway restart`

---

## Security recommendations

- Do not commit real `appSecret/aesKey` to public repositories
- Use secret management solutions in production
- Only allow trusted users/groups to trigger the bot

---

## Version and compatibility notes

- Current media sending uses Lanxin's common compatibility path: `msgType=text` + `msgData.text.mediaType/mediaIds`.
- Callback path matching uses `pathname`, supporting query parameters (e.g., `timestamp/nonce/signature`).
- If your Lanxin tenant API domain differs, explicitly set `apiBaseUrl`.
- Lanxin app token endpoint (`apptoken/create`) uses `GET` with query params (`grant_type/appid/secret`) per platform spec.

---

## Related documentation

- [Channels overview](/channels)
- [Group message policies](/channels/groups)
- [Gateway configuration](/gateway/configuration)
