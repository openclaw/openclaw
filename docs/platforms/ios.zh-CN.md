---
summary: "iOS 节点应用：连接到网关、配对、画布和故障排除"
read_when:
  - 配对或重新连接 iOS 节点
  - 从源代码运行 iOS 应用
  - 调试网关发现或画布命令
title: "iOS 应用"
---

# iOS 应用（节点）

可用性：内部预览。iOS 应用尚未公开发布。

## 它的功能

- 通过 WebSocket（LAN 或 tailnet）连接到网关。
- 暴露节点功能：画布、屏幕快照、相机捕获、位置、通话模式、语音唤醒。
- 接收 `node.invoke` 命令并报告节点状态事件。

## 要求

- 网关在另一台设备上运行（macOS、Linux 或通过 WSL2 的 Windows）。
- 网络路径：
  - 通过 Bonjour 的同一 LAN，**或**
  - 通过单播 DNS-SD 的 Tailnet（示例域：`openclaw.internal.`），**或**
  - 手动主机/端口（回退）。

## 快速开始（配对 + 连接）

1. 启动网关：

```bash
openclaw gateway --port 18789
```

2. 在 iOS 应用中，打开设置并选择发现的网关（或启用手动主机并输入主机/端口）。

3. 在网关主机上批准配对请求：

```bash
openclaw devices list
openclaw devices approve <requestId>
```

如果应用使用更改的身份验证详细信息（角色/范围/公钥）重试配对，
先前的待处理请求将被取代，并创建新的 `requestId`。
在批准前再次运行 `openclaw devices list`。

4. 验证连接：

```bash
openclaw nodes status
openclaw gateway call node.list --params "{}"
```

## 官方构建的中继支持推送

官方分发的 iOS 构建使用外部推送中继，而不是将原始 APNs 令牌发布到网关。

网关端要求：

```json5
{
  gateway: {
    push: {
      apns: {
        relay: {
          baseUrl: "https://relay.example.com",
        },
      },
    },
  },
}
```

流程工作原理：

- iOS 应用使用 App Attest 和应用收据向中继注册。
- 中继返回一个不透明的中继句柄和一个注册范围的发送授权。
- iOS 应用获取配对的网关身份并将其包含在中继注册中，因此中继支持的注册被委托给该特定网关。
- 应用通过 `push.apns.register` 将该中继支持的注册转发给配对的网关。
- 网关使用该存储的中继句柄进行 `push.test`、后台唤醒和唤醒轻推。
- 网关中继基础 URL 必须与官方/TestFlight iOS 构建中内置的中继 URL 匹配。
- 如果应用后来连接到不同的网关或具有不同中继基础 URL 的构建，它会刷新中继注册，而不是重用旧绑定。

此路径中网关**不需要**的内容：

- 无需部署范围的中继令牌。
- 官方/TestFlight 中继支持发送无需直接 APNs 密钥。

预期的操作员流程：

1. 安装官方/TestFlight iOS 构建。
2. 在网关上设置 `gateway.push.apns.relay.baseUrl`。
3. 将应用配对到网关并让其完成连接。
4. 应用在获得 APNs 令牌、操作员会话已连接且中继注册成功后自动发布 `push.apns.register`。
5. 之后，`push.test`、重新连接唤醒和唤醒轻推可以使用存储的中继支持注册。

兼容性说明：

- `OPENCLAW_APNS_RELAY_BASE_URL` 仍然作为网关的临时环境覆盖有效。

## 身份验证和信任流程

中继的存在是为了强制执行直接 APNs-on-gateway 无法为官方 iOS 构建提供的两个约束：

- 只有通过 Apple 分发的正版 OpenClaw iOS 构建才能使用托管中继。
- 网关只能为与该特定网关配对的 iOS 设备发送中继支持的推送。

逐跳：

1. `iOS app -> gateway`
   - 应用首先通过正常的网关身份验证流程与网关配对。
   - 这为应用提供了经过身份验证的节点会话和经过身份验证的操作员会话。
   - 操作员会话用于调用 `gateway.identity.get`。

2. `iOS app -> relay`
   - 应用通过 HTTPS 调用中继注册端点。
   - 注册包括 App Attest 证明和应用收据。
   - 中继验证 bundle ID、App Attest 证明和 Apple 收据，并要求官方/生产分发路径。
   - 这会阻止本地 Xcode/开发构建使用托管中继。本地构建可能已签名，但不满足中继期望的官方 Apple 分发证明。

3. `gateway identity delegation`
   - 在中继注册之前，应用从 `gateway.identity.get` 获取配对的网关身份。
   - 应用在中继注册有效负载中包含该网关身份。
   - 中继返回一个中继句柄和一个委托给该网关身份的注册范围发送授权。

4. `gateway -> relay`
   - 网关存储来自 `push.apns.register` 的中继句柄和发送授权。
   - 在 `push.test`、重新连接唤醒和唤醒轻推时，网关使用自己的设备身份签署发送请求。
   - 中继根据注册中委托的网关身份验证存储的发送授权和网关签名。
   - 另一个网关无法重用该存储的注册，即使它以某种方式获得了句柄。

5. `relay -> APNs`
   - 中继拥有生产 APNs 凭据和官方构建的原始 APNs 令牌。
   - 网关永远不会存储中继支持的官方构建的原始 APNs 令牌。
   - 中继代表配对的网关向 APNs 发送最终推送。

创建此设计的原因：

- 保持生产 APNs 凭据不在用户网关中。
- 避免在网关上存储原始官方构建 APNs 令牌。
- 仅允许官方/TestFlight OpenClaw 构建使用托管中继。
- 防止一个网关向属于不同网关的 iOS 设备发送唤醒推送。

本地/手动构建仍然使用直接 APNs。如果您在没有中继的情况下测试这些构建，网关仍然需要直接 APNs 凭据：

```bash
export OPENCLAW_APNS_TEAM_ID="TEAMID"
export OPENCLAW_APNS_KEY_ID="KEYID"
export OPENCLAW_APNS_PRIVATE_KEY_P8="$(cat /path/to/AuthKey_KEYID.p8)"
```

这些是网关主机运行时环境变量，不是 Fastlane 设置。`apps/ios/fastlane/.env` 仅存储 App Store Connect / TestFlight 身份验证，如 `ASC_KEY_ID` 和 `ASC_ISSUER_ID`；它不配置本地 iOS 构建的直接 APNs 传递。

推荐的网关主机存储：

```bash
mkdir -p ~/.openclaw/credentials/apns
chmod 700 ~/.openclaw/credentials/apns
mv /path/to/AuthKey_KEYID.p8 ~/.openclaw/credentials/apns/AuthKey_KEYID.p8
chmod 600 ~/.openclaw/credentials/apns/AuthKey_KEYID.p8
export OPENCLAW_APNS_PRIVATE_KEY_PATH="$HOME/.openclaw/credentials/apns/AuthKey_KEYID.p8"
```

不要提交 `.p8` 文件或将其放在 repo checkout 下。

## 发现路径

### Bonjour（LAN）

iOS 应用在 `local.` 上浏览 `_openclaw-gw._tcp`，并在配置时浏览相同的广域 DNS-SD 发现域。同一 LAN 上的网关会自动从 `local.` 出现；跨网络发现可以使用配置的广域域而不更改信标类型。

### Tailnet（跨网络）

如果 mDNS 被阻止，请使用单播 DNS-SD 区域（选择一个域；示例：`openclaw.internal.`）和 Tailscale 拆分 DNS。
请参阅 [Bonjour](/gateway/bonjour) 了解 CoreDNS 示例。

### 手动主机/端口

在设置中，启用**手动主机**并输入网关主机 + 端口（默认 `18789`）。

## 画布 + A2UI

iOS 节点渲染 WKWebView 画布。使用 `node.invoke` 来驱动它：

```bash
openclaw nodes invoke --node "iOS Node" --command canvas.navigate --params '{"url":"http://<gateway-host>:18789/__openclaw__/canvas/"}'
```

注意：

- 网关画布主机提供 `/__openclaw__/canvas/` 和 `/__openclaw__/a2ui/`。
- 它从网关 HTTP 服务器提供（与 `gateway.port` 相同的端口，默认 `18789`）。
- 当画布主机 URL 被广告时，iOS 节点在连接时自动导航到 A2UI。
- 使用 `canvas.navigate` 和 `{"url":""}` 返回内置脚手架。

### 画布评估 / 快照

```bash
openclaw nodes invoke --node "iOS Node" --command canvas.eval --params '{"javaScript":"(() => { const {ctx} = window.__openclaw; ctx.clearRect(0,0,innerWidth,innerHeight); ctx.lineWidth=6; ctx.strokeStyle=\"#ff2d55\"; ctx.beginPath(); ctx.moveTo(40,40); ctx.lineTo(innerWidth-40, innerHeight-40); ctx.stroke(); return \"ok\"; })()"}'
```

```bash
openclaw nodes invoke --node "iOS Node" --command canvas.snapshot --params '{"maxWidth":900,"format":"jpeg"}'
```

## 语音唤醒 + 通话模式

- 语音唤醒和通话模式在设置中可用。
- iOS 可能会暂停后台音频；当应用不活动时，将语音功能视为尽力而为。

## 常见错误

- `NODE_BACKGROUND_UNAVAILABLE`：将 iOS 应用带到前台（画布/相机/屏幕命令需要它）。
- `A2UI_HOST_NOT_CONFIGURED`：网关未广告画布主机 URL；检查 [网关配置](/gateway/configuration) 中的 `canvasHost`。
- 配对提示从未出现：运行 `openclaw devices list` 并手动批准。
- 重新安装后重新连接失败：Keychain 配对令牌已清除；重新配对节点。

## 相关文档

- [配对](/channels/pairing)
- [发现](/gateway/discovery)
- [Bonjour](/gateway/bonjour)
