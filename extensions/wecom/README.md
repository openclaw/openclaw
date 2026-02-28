# WeCom (企业微信) 插件

OpenClaw 的企业微信渠道插件，支持通过自建应用接收和发送消息，适用于私聊和群聊场景。

## 功能

- **私聊**：用户通过企业微信应用直接与 AI 对话
- **群聊**：在群聊中接收消息，支持白名单和 @提醒策略
- **多账户**：支持多个企业微信应用同时运行
- **消息类型**：接收文本、图片、文件、位置、链接、语音、视频消息；发送文本消息
- **会话历史**：保持连续对话上下文
- **消息去重**：自动过滤企业微信重试导致的重复消息
- **出站发送**：支持通过 `openclaw message send` 主动向用户发送消息

## 支持的消息类型

| 类型       | 接收 | 发送 | 说明                      |
| ---------- | ---- | ---- | ------------------------- |
| `text`     | ✅   | ✅   | 文本消息                  |
| `image`    | ✅   | ❌   | 图片（以文字描述转交 AI） |
| `file`     | ✅   | ❌   | 文件（以文件名转交 AI）   |
| `voice`    | ✅   | ❌   | 语音（仅识别，不转写）    |
| `video`    | ✅   | ❌   | 视频（仅识别）            |
| `location` | ✅   | ❌   | 位置（坐标 + 标签）       |
| `link`     | ✅   | ❌   | 链接（标题 + URL）        |

## 前置条件

### 1. 创建企业微信自建应用

1. 登录企业微信管理后台：https://work.weixin.qq.com/
2. 进入 **应用管理** → **自建** → **创建应用**
3. 填写应用名称、Logo，设置可见范围

### 2. 获取应用凭证

在应用详情页获取以下信息：

- **企业 ID (CorpID)**：「我的企业」→「企业信息」中查看
- **AgentID**：应用详情页顶部
- **Secret**：应用详情页「Secret」栏（点击查看）

### 3. 配置接收消息

1. 在应用详情页找到 **接收消息** 配置，点击「设置 API 接收」
2. 填写以下信息：

**URL：** `https://your-server/wecom/events`（需公网可访问）

**Token：** 随机字符串，例如：

```bash
openssl rand -base64 32 | tr -d "=+/" | cut -c1-32
```

**EncodingAESKey：** 点击「随机获取」自动生成

3. 先启动 OpenClaw Gateway，再点击「保存」（企业微信会发验证请求）

## 配置

编辑 `~/.openclaw/config.yaml`：

```yaml
channels:
  wecom:
    enabled: true

    # 应用凭证
    corpId: "ww1234567890abcdef"
    agentId: "1000002"
    secret: "your_secret_here"

    # Webhook 配置
    token: "your_token_here"
    encodingAESKey: "your_aes_key_here"
    webhookPort: 3000
    webhookPath: "/wecom/events"
    webhookHost: "0.0.0.0"

    # 访问策略
    dmPolicy: "pairing" # 私聊策略: open / pairing / allowlist
    groupPolicy: "allowlist" # 群聊策略: open / allowlist / disabled
    requireMention: false # 群聊是否需要 @机器人才响应

    # 白名单（allowlist 策略时生效）
    allowFrom:
      - "userid1"
      - "userid2"
    groupAllowFrom:
      - "chatid1"

    # 历史上下文
    historyLimit: 20 # 群聊历史条数
    dmHistoryLimit: 20 # 私聊历史条数

    # 文本分块（超长回复自动拆分）
    textChunkLimit: 2000
```

### 配置项说明

#### `dmPolicy` — 私聊策略

| 值          | 说明                                 |
| ----------- | ------------------------------------ |
| `open`      | 允许所有用户（`allowFrom` 含 `"*"`） |
| `pairing`   | 首次使用需配对审批                   |
| `allowlist` | 仅 `allowFrom` 列表中的用户          |

#### `groupPolicy` — 群聊策略

| 值          | 说明                                     |
| ----------- | ---------------------------------------- |
| `open`      | 允许所有群聊                             |
| `allowlist` | 仅 `groupAllowFrom` 列表中的群聊 Chat ID |
| `disabled`  | 禁用群聊功能                             |

#### `requireMention`

- `false`（默认）：群聊中所有消息都响应
- `true`：群聊中仅当消息包含 @机器人时响应（注：企业微信基础事件暂不含 @信息，此选项会跳过所有群消息，暂不建议使用）

## 网络要求

企业微信服务器需要能访问你的 Webhook URL（需要公网 IP 或内网穿透）。

**使用 ngrok（测试用）：**

```bash
ngrok http 3000
```

**防火墙放行：**

```bash
# Ubuntu/Debian
sudo ufw allow 3000/tcp
```

## 启动

```bash
openclaw gateway start
openclaw status
```

启动成功后日志会显示：

```
wecom[default]: Webhook server listening on 0.0.0.0:3000/wecom/events
```

## 出站发送

配置好 `outbound` 后，可以通过 CLI 主动发送消息：

```bash
openclaw message send --channel wecom --target "userid" --message "你好"
```

## 常见问题

### Webhook 验证失败

- 检查 Gateway 是否启动：`openclaw status`
- 检查端口是否监听：`netstat -tlnp | grep 3000`
- 检查 `token` 和 `encodingAESKey` 是否与企业微信后台一致

### 收不到消息

```bash
# 查看是否有消息到达
openclaw gateway logs | grep "received.*message"

# 查看是否被策略拦截
openclaw gateway logs | grep "not in allowlist\|skipping"
```

### 发送失败

```bash
# 检查 access_token 获取是否正常
openclaw gateway logs | grep "access_token\|WeCom send error"
```

验证 API 连通性：

```bash
curl "https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=YOUR_CORPID&corpsecret=YOUR_SECRET"
```

### 群聊不响应

检查 `groupPolicy` 和 `groupAllowFrom` 配置；若 `requireMention: true`，当前版本会跳过所有群消息。

## 错误码参考

| 错误码 | 说明                  | 解决方法               |
| ------ | --------------------- | ---------------------- |
| 40001  | 不合法的 secret       | 检查 secret            |
| 40013  | 不合法的 corpid       | 检查 corpId            |
| 40014  | 不合法的 access_token | Token 过期，会自动刷新 |
| 42001  | access_token 超时     | 自动刷新               |
| 60020  | 不合法的 agentid      | 检查 agentId           |

## 参考文档

- [企业微信开发文档](https://developer.work.weixin.qq.com/document/)
- [接收消息 API](https://developer.work.weixin.qq.com/document/path/90238)
- [发送消息 API](https://developer.work.weixin.qq.com/document/path/90236)
