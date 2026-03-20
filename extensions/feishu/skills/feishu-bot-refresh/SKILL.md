---
name: feishu-bot-refresh
description: |
  Refresh Feishu bot identity information. Activate when user sends /refresh-bot-name or mentions refreshing bot name.
---

# Feishu Bot Identity Refresh

Refreshes the bot's identity information from Feishu API when requested by user.

## Trigger Conditions

Activate when user message contains:
- `/refresh-bot-name`
- `刷新机器人名称`
- `更新机器人信息`
- `refresh bot name`

## Execution Steps

### 1. Get Current Account Configuration

Read the current account's `app_id` and `app_secret` from `~/.openclaw/openclaw.json`:

```json
{
  "channels": {
    "feishu": {
      "accounts": {
        "dev-1": {
          "appId": "cli_a93e6ea211b89cd2",
          "appSecret": "xxx"
        }
      }
    }
  }
}
```

### 2. Get Tenant Access Token

Call Feishu API:

```bash
curl -X POST "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal" \
  -H "Content-Type: application/json" \
  -d '{
    "app_id": "<appId>",
    "app_secret": "<appSecret>"
  }'
```

Response:
```json
{
  "code": 0,
  "tenant_access_token": "t-xxx",
  "expire": 7200
}
```

### 3. Query Bot Info

Call Feishu API:

```bash
curl -X GET "https://open.feishu.cn/open-apis/bot/v3/info" \
  -H "Authorization: Bearer <tenant_access_token>"
```

Response:
```json
{
  "code": 0,
  "bot": {
    "activate_status": 2,
    "app_name": "OCT10-开发 1",
    "avatar_url": "https://xxx",
    "open_id": "ou_xxx"
  }
}
```

### 4. Save to Identity File

Write to `~/.openclaw/agents/main/sessions/bot-identity.json`:

```json
{
  "feishu": {
    "appId": "<current_app_id>",
    "appName": "<app_name from API>",
    "openId": "<open_id from API>",
    "activateStatus": 2,
    "avatarUrl": "<avatar_url from API>",
    "queriedAt": "<ISO 8601 timestamp>"
  }
}
```

### 5. Reply to User

Confirm the refresh with formatted output:

```
✅ 机器人信息已刷新：

- **名称：** OCT10-开发 1
- **OpenID：** ou_xxx
- **激活状态：** 已激活
- **查询时间：** 2026-03-19 23:50:00
```

## Error Handling

| Error | Response |
|-------|----------|
| API call failed | ❌ 刷新失败：{error message} |
| Invalid token | ❌ 刷新失败：凭证无效，请检查飞书应用配置 |
| File write failed | ❌ 刷新失败：无法保存配置文件 |

## Configuration

```yaml
channels:
  feishu:
    tools:
      bot_refresh: true  # default: true
```

## Permissions

Required: No special permissions needed (uses app's internal token)

## Examples

### User sends command
```
/refresh-bot-name
```

### Bot responds
```
✅ 机器人信息已刷新：

- **名称：** OCT10-开发 1
- **OpenID：** ou_0900e4a9853a4369b7010352d36d8a6c
- **激活状态：** 已激活
- **查询时间：** 2026-03-19 23:50:00
```

## Notes

- This is a user-triggered action, not automatic
- Cache does not expire automatically
- User should run this after changing bot name in Feishu platform
- Each account has its own identity file
