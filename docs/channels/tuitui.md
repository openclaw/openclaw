---
summary: "推推 IM 机器人 channel 状态与配置"
read_when:
  - Working on 推推 IM 集成或出站消息
title: "推推 (Tuitui)"
---

# 推推 (Tuitui)

推推 IM 机器人通道，对接 360 集团内推推 IM（alarm.im.qihoo.net）。以推推 IM 机器人开发文档为准。

状态：实验性。支持出站（发文本）与入站（收消息 webhook）；群聊仅处理 @机器人 的消息。

## 插件要求

推推以插件形式提供，不随核心安装包内置。

- CLI 安装：`openclaw plugins install @openclaw/tuitui`
- 源码 安装：`openclaw plugins install ./extensions/tuitui`
- 详见 [Plugins](/tools/plugin)

## 申请与鉴权

1. **申请开通**（360 集团内）：在 qlink (https://qlink.qihoo.net/apps/home) 提交申请 → 新建事项 → 搜索「推推」→ 选择「申请推推机器人」；申请通过后管理员将 **appid** 和 **secret** 回填到申请单。
2. **鉴权**：接口使用 URL 参数 `appid` 与 `secret` 鉴权。
3. **外网**：默认 `alarm.im.qihoo.net` 仅内网可访问。外网发消息需申请开通，开通后使用：`TUITUI_API_BASE=https://im.live.360.cn:8282/robot`。

## 快速配置

1. 安装插件：`openclaw plugins install @openclaw/tuitui` 或 `./extensions/tuitui`
2. 配置 **appId** 与 **secret**：
   - **环境变量**（仅 default 账户）：`TUITUI_APPID=...`、`TUITUI_SECRET=...`
   - **配置文件**：`channels.tuitui.appId`、`channels.tuitui.secret`，或 `channels.tuitui.secretFile` 指向存 secret 的文件
   - **CLI 添加**：`openclaw channels add --channel tuitui --token "appId:secret"` 或 `--token-file /path/to/file`（文件两行：第一行 appId，第二行 secret）
3. 重启 gateway 或完成 onboarding。

最小配置示例：

```json5
{
  channels: {
    tuitui: {
      enabled: true,
      appId: "申请单回填的 appid",
      secret: "申请单回填的 secret",
      dmPolicy: "pairing",
    },
  },
}
```

## 发送范围与 to 含义

- **发给人**：`to` 填域账号（如 `zhangsan`），接口使用 `tousers`；360 集团用户为域账号，其他租户以管理员说明为准。
- **发给群**：`to` 填群 ID（纯数字且长度≥10），接口使用 `togroups`；群 ID 在 PC 端群详情中复制。
- 单次请求仅支持「全部为人」或「全部为群」，不能混发。

## 配置项

| 配置键 | 说明 |
|--------|------|
| `channels.tuitui.enabled` | 是否启用 |
| `channels.tuitui.appId` | 推推机器人 appid（开发者账号） |
| `channels.tuitui.secret` | 推推机器人 secret（开发者密钥） |
| `channels.tuitui.secretFile` | 存 secret 的文件路径（与 secret 二选一） |
| `channels.tuitui.webhookPath` | 收消息回调 path，默认 `/tuitui-webhook` |
| `channels.tuitui.webhookBaseUrl` | 网关公网 base URL；配置后启动时自动调用推推「改收消息回调url」，无需在推推后台手动配置。例：`https://gateway.example.com` |
| `channels.tuitui.dmPolicy` | 策略：pairing / allowlist / open / disabled |
| `channels.tuitui.allowFrom` | allowlist（域账号或群 ID 等） |

多账户使用 `channels.tuitui.accounts.<accountId>`，可选 `channels.tuitui.defaultAccount`。

## 接口说明（与官方文档一致）

- **域名**：默认 `https://alarm.im.qihoo.net`；外网可用 `TUITUI_API_BASE=https://im.live.360.cn:8282/robot`。
- **发文本**：POST `/message/custom/send?appid={APPID}&secret={SECRET}`，Body JSON：`tousers` 或 `togroups`、`msgtype: "text"`、`text: { content }`；响应先看 HTTP 200，再看 `errcode === 0`。
- **鉴权**：GET `/robot/prop/get?appid=...&secret=...` 用于 probe 校验。

## 收消息（入站）

使用推推文档「5、机器人收消息」：收消息回调 url 由业务提供，推推通过 HTTP POST 推送到该 url；请求头含鉴权字段，body 为 JSON 事件（single_chat_open、single_chat、group_chat 等）。

**无需在推推后台手动配置**：在配置中设置 `webhookBaseUrl`（如 `https://你的网关域名`）后，启动时插件会自动调用推推「改收消息回调url」接口（POST /robot/webhook/modify），将回调设为 `webhookBaseUrl + webhookPath`（默认 path 为 `/tuitui-webhook`）。接口限速 1 次/分钟，修改约 5 分钟后生效。

- **鉴权**：请求头 `X-Tuitui-Robot-Appid`、`X-Tuitui-Robot-Timestamp`、`X-Tuitui-Robot-Nonce`、`X-Tuitui-Robot-Checksum`，插件按文档用 `sha1(app_secret + timestamp + nonce + post的json_body)` 校验。
- **事件**：处理 `single_chat`、`group_chat` 文本消息；群聊仅处理 `at_me === true` 的消息（即 @机器人 才回复）。

### 本机部署 + ngrok

网关跑在本机、用 ngrok 暴露公网时，可直接用上述 `webhookBaseUrl` 自动注册回调：

1. 启动 ngrok 映射网关端口，例如：`ngrok http 18789`，记下生成的公网 URL（如 `https://abc123.ngrok-free.app`）。
2. 配置中设置 `webhookBaseUrl` 为该 URL（不要带 path、不要末尾斜杠），例如：
   ```json5
   channels: {
     tuitui: {
       enabled: true,
       appId: "xxx",
       secret: "xxx",
       webhookBaseUrl: "https://abc123.ngrok-free.app",
       webhookPath: "/tuitui-webhook"
     },
   }
   ```
3. 启动 OpenClaw gateway；插件会把推推收消息回调设为 `https://abc123.ngrok-free.app/tuitui-webhook`，约 5 分钟后生效。推推 POST 到该 URL 时由 ngrok 转发到本机，插件按「5、机器人收消息」处理。

注意：ngrok 免费版重启后域名会变，需更新 `webhookBaseUrl` 并重启 gateway；使用固定域名则配置一次即可。

文档根路径：[Channels](/channels)，[Configuration](/configuration)。
