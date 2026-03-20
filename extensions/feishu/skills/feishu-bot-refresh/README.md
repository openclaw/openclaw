# Feishu Bot Identity Refresh Skill

刷新飞书机器人身份信息的技能。

## 功能

当用户在飞书后台修改机器人名称后，可以通过此技能刷新机器人的身份信息。

## 使用方式

### 方式 1：发送指令（推荐）

在飞书聊天中发送以下任一指令：

```
/refresh-bot-name
刷新机器人名称
更新机器人信息
```

机器人会自动查询飞书 API 并更新身份信息。

### 方式 2：运行脚本

```bash
# 刷新当前账号
~/.openclaw/extensions/feishu/skills/feishu-bot-refresh/refresh-bot.sh

# 刷新指定账号
~/.openclaw/extensions/feishu/skills/feishu-bot-refresh/refresh-bot.sh dev-1

# 输出 JSON 格式
~/.openclaw/extensions/feishu/skills/feishu-bot-refresh/refresh-bot.sh dev-1 --json
```

## 输出示例

```
✅ 机器人信息已刷新：

  - **名称：** OCT10-开发 1
  - **OpenID：** ou_0900e4a9853a4369b7010352d36d8a6c
  - **激活状态：** 已激活
  - **查询时间：** 2026-03-19T23:54:04+08:00
```

## 配置文件

刷新后的信息保存在：

```
~/.openclaw/agents/main/sessions/bot-identity.json
```

格式：

```json
{
  "feishu": {
    "appId": "cli_a93e6ea211b89cd2",
    "appName": "OCT10-开发 1",
    "openId": "ou_0900e4a9853a4369b7010352d36d8a6c",
    "activateStatus": 2,
    "avatarUrl": "https://xxx",
    "queriedAt": "2026-03-19T23:54:04+08:00"
  }
}
```

## 支持的账号

所有在 `~/.openclaw/openclaw.json` 中配置的飞书账号都支持刷新：

- `dev-1` - 软件团队 1-开发 1
- `dev-2` - 软件团队 1-开发 2
- `test-1` - 软件团队 1-测试 1
- `doc-1` - 软件团队 1-文档 1
- `mgr-1` - 软件团队 1-管理 1
- `default` - 主机器人

## API 调用

此技能调用以下飞书开放平台 API：

1. **获取访问令牌**
   - `POST /open-apis/auth/v3/tenant_access_token/internal`
   
2. **查询机器人信息**
   - `GET /open-apis/bot/v3/info`

## 权限

不需要额外权限，使用应用的内部凭证即可。

## 故障排除

### 刷新失败：找不到账号配置

确保账号 ID 在 `~/.openclaw/openclaw.json` 中存在：

```json
{
  "channels": {
    "feishu": {
      "accounts": {
        "dev-1": { ... }
      }
    }
  }
}
```

### 刷新失败：凭证无效

检查 `app_id` 和 `app_secret` 是否正确。

### 刷新失败：无法保存配置文件

确保有写入 `~/.openclaw/agents/main/sessions/` 目录的权限。

## 版本

- v1.0 - 初始版本

---

**开发：** OpenClaw Team  
**日期：** 2026-03-19
