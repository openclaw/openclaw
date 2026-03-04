# 钉钉、QQ、微信公众号频道完整实现规划与开发清单

本文档给出 **DingTalk（钉钉）**、**QQ**、**WeChat MP（微信公众号）** 三个频道从当前占位实现到完整可用的详细规划与开发行动清单。实施时建议按「阶段」顺序推进，每个阶段内任务可并行或按依赖关系排序。

---

## 一、总体架构与共用能力

三个频道均需实现以下能力（与现有 Synology Chat / Google Chat / Zalo / Feishu 等一致）：

| 能力                | 说明                                                                                                              | 参考实现                                                                        |
| ------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| **入站 (Inbound)**  | 平台把用户消息/事件推到 Gateway，经校验后转成 OpenClaw 会话并触发 Agent 回复                                      | Synology Chat `webhook-handler` + `channel.gateway.startAccount` 注册 HTTP 路由 |
| **出站 (Outbound)** | Agent 回复通过频道 API 发回用户（文本/媒体）                                                                      | Feishu `outbound.ts`、Synology `sendMessage`                                    |
| **会话与路由**      | `finalizeInboundContext` + `dispatchReplyWithBufferedBlockDispatcher`，统一 From/To/SessionKey/OriginatingChannel | `extensions/synology-chat/src/channel.ts` L267–320                              |
| **配置与账号**      | `listAccountIds` / `resolveAccount`，多账号可选，敏感配置可走环境变量                                             | 各扩展 `accounts.ts`                                                            |
| **安全与限流**      | Token/签名校验、防重放、Rate limit、DM 策略（allowlist/pairing）                                                  | Synology `security.ts`、Google Chat `monitor-access.js`                         |
| **状态与探测**      | `status.probeAccount` / `buildAccountSnapshot`（可选），便于 `channels status --probe`                            | Feishu probe、BlueBubbles status                                                |

以下按 **钉钉 → QQ → 微信公众号** 分别给出平台要点与开发清单，再汇总共用任务与测试/文档。

---

## 二、钉钉（DingTalk）完整实现

### 2.1 平台要点

- **接收消息**
  - **HTTP 模式**：在钉钉开放平台配置「机器人消息接收地址」，钉钉服务器向该 URL 发送 POST（JSON）。
  - 文档：[接收消息 - 钉钉开放平台](https://open.dingtalk.com/document/dingstart/receive-message)、[接收消息的消息协议](https://open.dingtalk.com/document/robots/receive-message)。
  - 需处理：验证 URL（若平台要求）、签名/解密、解析 `senderId`、`sessionWebhook`、`conversationId`、消息体（文本/图片等）。

- **发送消息**
  - **SessionWebhook**：接收消息回调里会带 `sessionWebhook`，可直接 POST 该 URL 回复当前会话（同 Synology 的 incoming webhook）。
  - **OpenAPI**：应用机器人需先拿 `access_token`（appKey + appSecret），再调 [发送消息](https://open.dingtalk.com/document/orgapp/send-message) 等接口。
  - 建议：入站解析并缓存 `sessionWebhook`（按会话/会话+用户维度），出站优先用 SessionWebhook，无则用 OpenAPI + 目标 conversationId/userId。

- **鉴权**
  - 应用机器人：appKey、appSecret，换 access_token。
  - 回调：根据文档做签名或解密校验（若有 encryptKey）。

### 2.2 钉钉开发行动清单

| 序号 | 任务                                     | 产出/修改文件                                                               | 说明                                                                                                                                                                                                    |
| ---- | ---------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1   | 设计并实现钉钉配置 Schema                | `extensions/dingtalk/src/types.ts`, `config-schema.ts`（或扩展现有 schema） | 增加 `appKey`、`appSecret`、`encryptKey`、`webhookPath`、`webhookHost`、`dmPolicy`、`allowFrom` 等；多账号 `accounts.<id>`。                                                                            |
| D2   | 实现 access_token 获取与缓存             | `extensions/dingtalk/src/token.ts` 或 `client.ts`                           | 使用 appKey+appSecret 调钉钉 token 接口，缓存至过期前 N 分钟刷新；可参考 Feishu/Telegram token 逻辑。                                                                                                   |
| D3   | 实现接收消息 HTTP 处理（校验 + 解析）    | `extensions/dingtalk/src/webhook-handler.ts`                                | 校验签名/解密；解析 senderId、conversationId、sessionWebhook、消息类型与文本/媒体；输出统一 InboundPayload。                                                                                            |
| D4   | 在 gateway.startAccount 中注册 HTTP 路由 | `extensions/dingtalk/src/channel.ts`                                        | 使用 `registerPluginHttpRoute` 注册 `webhookPath`；在 handler 内调用 webhook-handler，再转 `finalizeInboundContext` + `dispatchReplyWithBufferedBlockDispatcher`；deliver 回调内调用发送逻辑（见 D5）。 |
| D5   | 实现出站发送（SessionWebhook + OpenAPI） | `extensions/dingtalk/src/send.ts` 或 `client.ts`                            | 文本：优先 SessionWebhook POST；若无则用 OpenAPI 发到 conversationId。媒体：按钉钉文档上传媒体再发。实现 `sendText`、`sendMedia`，在 channel 的 outbound 与 gateway deliver 中调用。                    |
| D6   | 账号解析与 listAccountIds                | `extensions/dingtalk/src/accounts.ts`                                       | 从 `channels.dingtalk` 及 `accounts` 解析 enabled、appKey、appSecret、webhookPath 等；listAccountIds 返回 default + 命名账号。                                                                          |
| D7   | 安全与限流                               | `extensions/dingtalk/src/security.ts`                                       | 签名/解密校验；可选防重放（messageId + TTL）；Rate limit 按 account 或 IP；resolveDmPolicy 使用 allowlist/pairing。                                                                                     |
| D8   | 配对/allowlist 与 notifyApproval         | `extensions/dingtalk/src/channel.ts`                                        | pairing.notifyApproval：通过 SessionWebhook 或 OpenAPI 发一条“已通过”给用户。                                                                                                                           |
| D9   | Status/Probe（可选）                     | `extensions/dingtalk/src/probe.ts` + channel.status                         | 用 access_token 调一个轻量 API（如获取机器人信息）判断配置是否有效；buildAccountSnapshot 填状态与 issues。                                                                                              |
| D10  | 单元测试与集成测试                       | `extensions/dingtalk/src/*.test.ts`                                         | webhook 解析、签名校验、token 刷新、send 的 mock 测试；可选与真实钉钉沙箱的 live 测试。                                                                                                                 |
| D11  | 文档与配置示例                           | `docs/channels/dingtalk.md`                                                 | 补齐「如何创建应用/机器人、配置接收 URL、最小配置示例、环境变量、故障排查」。                                                                                                                           |

---

## 三、QQ 完整实现

### 3.1 平台要点

- **接收事件**
  - QQ 机器人通过 **HTTP 回调** 接收事件（非长轮询）。在 QQ 开放平台「开发 → 回调配置」配置 URL（仅 HTTPS，端口 80/443/8080/8443）。
  - 文档：[事件订阅与通知](https://bot.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/event-emit.html)。
  - 回调为 POST，Body 为统一 Payload：`op`、`d`、`t`（事件名）等；需处理 **验证请求**（如 plain_token + 签名 Ed25519）与 **Dispatch 推送**（op=0）。
  - 需及时返回 HTTP Callback ACK（opcode=12）表示已接收。

- **消息事件类型**
  - 单聊：`C2C_MESSAGE_CREATE`；群 @：`GROUP_AT_MESSAGE_CREATE`；频道私信：`DIRECT_MESSAGE_CREATE`；子频道 @：`AT_MESSAGE_CREATE`。
  - 从 `d` 中解析发送者 openid、channel_id、message 等，映射为 OpenClaw 的 From/To/SessionKey/chatType。

- **发送消息**
  - 鉴权：先调 `https://bots.qq.com/app/getAppAccessToken`（appId + clientSecret）拿 token，请求头 `Authorization: QQBot <token>`。
  - 文档：[发送消息](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/send-receive/send.html)。
  - 限制：单聊/群被动回复 5 分钟窗口、次数限制；频道子频道每日条数等，需在发送逻辑或文档中说明。

### 3.2 QQ 开发行动清单

| 序号 | 任务                                     | 产出/修改文件                                    | 说明                                                                                                                                                                         |
| ---- | ---------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1   | 设计并实现 QQ 配置 Schema                | `extensions/qq/src/types.ts`, `config-schema.ts` | `appId`、`clientSecret`（或 token）、`webhookPath`、`webhookSecret`（若平台提供）、`dmPolicy`、`allowFrom`；多账号。                                                         |
| Q2   | 实现 QQ access_token 获取与缓存          | `extensions/qq/src/token.ts` 或 `api.ts`         | 调 `getAppAccessToken`，缓存 7200s 内刷新。                                                                                                                                  |
| Q3   | 实现回调验证与事件解析                   | `extensions/qq/src/webhook-handler.ts`           | 验证请求：计算 Ed25519 签名并回写；Dispatch：解析 op、d、t，提取 message、openid、channel_id 等，输出统一 InboundPayload；返回 ACK（opcode=12）。                            |
| Q4   | 在 gateway.startAccount 中注册 HTTP 路由 | `extensions/qq/src/channel.ts`                   | `registerPluginHttpRoute` 绑定 webhookPath；handler 内调用 webhook-handler，再转 finalizeInboundContext + dispatchReplyWithBufferedBlockDispatcher；deliver 调用发送（Q5）。 |
| Q5   | 实现出站发送（调用 QQ 发送 API）         | `extensions/qq/src/send.ts` 或 `api.ts`          | 根据会话类型（单聊/群/频道私信/子频道）调对应发送 API；支持文本与媒体（按 QQ 文档）；在 channel.outbound.sendText/sendMedia 与 gateway deliver 中使用。                      |
| Q6   | 账号解析与 listAccountIds                | `extensions/qq/src/accounts.ts`                  | 解析 `channels.qq` 及 accounts，返回账号列表与 resolveAccount。                                                                                                              |
| Q7   | 安全与限流                               | `extensions/qq/src/security.ts`                  | 签名校验、防重放（msg_seq/event_id）、Rate limit；resolveDmPolicy。                                                                                                          |
| Q8   | 配对与 notifyApproval                    | `extensions/qq/src/channel.ts`                   | 通过 QQ 发送 API 向对应用户发“已通过”消息。                                                                                                                                  |
| Q9   | Status/Probe（可选）                     | `extensions/qq/src/probe.ts` + channel.status    | 用 token 调一个只读 API 验证配置。                                                                                                                                           |
| Q10  | 单元测试与集成测试                       | `extensions/qq/src/*.test.ts`                    | 验证请求/ACK、事件解析、send mock。                                                                                                                                          |
| Q11  | 文档与配置示例                           | `docs/channels/qq.md`                            | 创建应用、配置回调 URL、签名说明、最小配置、限制说明。                                                                                                                       |

---

## 四、微信公众号（WeChat MP）完整实现

### 4.1 平台要点

- **接收消息与事件**
  - 在微信公众平台配置「服务器地址」URL。GET 用于验证（echostr + 签名），POST 用于接收消息/事件（XML 或 JSON）。
  - 文档：[接收消息和事件](https://developers.weixin.qq.com/doc/offiaccount/Message_Management/Receiving_standard_messages.html)。
  - 需校验 signature（token + timestamp + nonce）；若开启加密，需用 appSecret 解密；解析 MsgType、FromUserName、ToUserName、Content/MediaId 等。

- **发送回复**
  - **48 小时内**可发「客服消息」：`POST https://api.weixin.qq.com/cgi-bin/message/custom/send?access_token=...`，body 中指定 touser（openid）、msgtype、text/image 等。
  - 或「被动回复」：在接收消息的 HTTP 响应里直接返回 XML（仅一次）。
  - 建议：默认使用客服消息接口，便于异步与多轮对话；access_token 用 appId + appSecret 获取并缓存。

### 4.2 微信公众号开发行动清单

| 序号 | 任务                                     | 产出/修改文件                                           | 说明                                                                                                                                                          |
| ---- | ---------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W1   | 设计并实现 WeChat MP 配置 Schema         | `extensions/wechat-mp/src/types.ts`, `config-schema.ts` | `appId`、`appSecret`、`token`（验证用）、`webhookPath`、`dmPolicy`、`allowFrom`；可选 encodingAESKey。                                                        |
| W2   | 实现 access_token 获取与缓存             | `extensions/wechat-mp/src/token.ts` 或 `api.ts`         | 调微信 token 接口，缓存 7200s。                                                                                                                               |
| W3   | 实现 GET 验证与 POST 消息解析            | `extensions/wechat-mp/src/webhook-handler.ts`           | GET：校验 signature，回写 echostr；POST：校验/解密，解析 MsgType、FromUserName、Content/MediaId，输出 InboundPayload；响应可先 200 空或短 XML 避免超时。      |
| W4   | 在 gateway.startAccount 中注册 HTTP 路由 | `extensions/wechat-mp/src/channel.ts`                   | registerPluginHttpRoute；handler 内调用 webhook-handler，再 finalizeInboundContext + dispatchReplyWithBufferedBlockDispatcher；deliver 调客服消息发送（W5）。 |
| W5   | 实现出站发送（客服消息 API）             | `extensions/wechat-mp/src/send.ts` 或 `api.ts`          | 调用 `message/custom/send`，支持 text、image 等；outbound.sendText/sendMedia 与 deliver 中使用；注意 48 小时窗口在文档中说明。                                |
| W6   | 账号解析与 listAccountIds                | `extensions/wechat-mp/src/accounts.ts`                  | 解析 channels.wechat-mp 与 accounts。                                                                                                                         |
| W7   | 安全与限流                               | `extensions/wechat-mp/src/security.ts`                  | signature 校验、解密、防重放、Rate limit、resolveDmPolicy。                                                                                                   |
| W8   | 配对与 notifyApproval                    | `extensions/wechat-mp/src/channel.ts`                   | 客服消息发“已通过”。                                                                                                                                          |
| W9   | Status/Probe（可选）                     | `extensions/wechat-mp/src/probe.ts` + channel.status    | token 有效即可认为配置正确。                                                                                                                                  |
| W10  | 单元测试与集成测试                       | `extensions/wechat-mp/src/*.test.ts`                    | 验证、解析、send mock。                                                                                                                                       |
| W11  | 文档与配置示例                           | `docs/channels/wechat-mp.md`                            | 公众号配置、服务器 URL、token、最小配置、48 小时与条数限制。                                                                                                  |

---

## 五、共用任务与约定

以下任务三个频道共用或需统一约定：

| 序号 | 任务                 | 说明                                                                                                                                                                                                                                                                                                                                                      |
| ---- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1   | **Inbound 统一流程** | 每个频道：HTTP handler → 校验/解析 → 构建 `finalizeInboundContext` 入参（From、To、SessionKey、Body、OriginatingChannel、ChatType、SenderId 等）→ `dispatchReplyWithBufferedBlockDispatcher`，`dispatcherOptions.deliver` 内调该频道 send。参考：`extensions/synology-chat/src/channel.ts` L257–320、`extensions/googlechat` processMessageWithPipeline。 |
| C2   | **Target 格式**      | 在 `messaging.normalizeTarget` 与 outbound 中统一：钉钉用 conversationId 或 userId；QQ 用 openid/channel_id；公众号用 openid。文档与 agentPrompt.messageToolHints 中说明。                                                                                                                                                                                |
| C3   | **媒体处理**         | 若平台需先上传再发：实现 uploadMedia + send 中引用 media_id；若支持 URL：按现有 sendMedia 传 mediaUrl 并下载后上传或直传（依平台文档）。                                                                                                                                                                                                                  |
| C4   | **环境变量**         | 敏感项支持从环境变量读取（如 DINGTALK_APP_KEY、QQ_APP_ID、WECHAT_MP_APP_SECRET），在 accounts 解析时与 config 合并，与现有扩展一致。                                                                                                                                                                                                                      |
| C5   | **日志与错误**       | 使用 `ctx.log` / runtime.log 打关键步骤与错误；避免把 token 等写进日志。                                                                                                                                                                                                                                                                                  |
| C6   | **CHANGELOG 与版本** | 每个频道首次完整可用时在 CHANGELOG 中记一笔；扩展 package.json version 与主库协调。                                                                                                                                                                                                                                                                       |

---

## 六、建议实施顺序

1. **先完成一个端到端**：建议先做 **钉钉** 或 **微信公众号**（HTTP 收发模型最接近 Synology Chat / Google Chat），打通「注册路由 → 收消息 → 会话 → 回复 → 发消息」全链路，再复制模式到另外两个。
2. **再并行三个频道**：按上表 D1–D11、Q1–Q11、W1–W11 分别实现；共用部分（C1–C6）在第一个频道实现时定稿，后两个复用。
3. **测试与文档**：每频道单元测试随开发写；集成/手动测试用各平台测试号或沙箱；文档在实现过程中补齐并在上线前校对。

---

## 七、参考文档与链接

- 钉钉：
  - [接收消息](https://open.dingtalk.com/document/dingstart/receive-message)、[消息协议](https://open.dingtalk.com/document/robots/receive-message)
  - [自定义机器人发送群消息](https://open.dingtalk.com/document/orgapp/custom-bot-to-send-group-chat-messages)、[应用机器人发送](https://open.dingtalk.com/document/orgapp/send-message)
- QQ：
  - [事件订阅与通知](https://bot.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/event-emit.html)、[发送消息](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/send-receive/send.html)、[鉴权](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/api-use.html)
- 微信公众号：
  - [接收消息](https://developers.weixin.qq.com/doc/offiaccount/Message_Management/Receiving_standard_messages.html)、[客服消息](https://developers.weixin.qq.com/doc/offiaccount/Message_Management/Service_Center_messages.html)

本仓库内可对照的扩展实现：`extensions/synology-chat`（HTTP webhook 收发）、`extensions/googlechat`（webhook 注册与处理）、`extensions/feishu`（outbound、config、多账号）、`extensions/zalo`（webhook + 发送 API）。

---

## 八、开发行动清单（可勾选）

按「先钉钉/公众号其一打通，再复制到 QQ 与另一」的顺序，可直接用下面清单跟踪进度。

### 钉钉（DingTalk）

- [x] D1 配置 Schema（types + config-schema）
- [x] D2 access_token 获取与缓存（token.ts / client.ts）
- [x] D3 webhook-handler（校验 + 解析入站）
- [x] D4 gateway 注册 HTTP 路由 + 入站转 finalizeInboundContext + dispatchReply
- [x] D5 出站发送（SessionWebhook + OpenAPI，sendText/sendMedia）
- [x] D6 accounts 完善（listAccountIds + resolveAccount）
- [x] D7 security（签名/限流/DM 策略）
- [x] D8 pairing.notifyApproval
- [x] D9 status/probe（可选）
- [x] D10 单元/集成测试
- [x] D11 文档 dingtalk.md 完善

### QQ

- [x] Q1 配置 Schema
- [x] Q2 access_token 获取与缓存
- [x] Q3 webhook-handler（验证请求 + 事件解析 + ACK）
- [x] Q4 gateway 注册路由 + 入站链路
- [x] Q5 出站发送（单聊/群/频道 API）
- [x] Q6 accounts 完善
- [x] Q7 security
- [x] Q8 pairing.notifyApproval
- [x] Q9 status/probe（可选）
- [x] Q10 单元/集成测试
- [x] Q11 文档 qq.md 完善

### 微信公众号（WeChat MP）

- [x] W1 配置 Schema
- [x] W2 access_token 获取与缓存
- [x] W3 webhook-handler（GET 验证 + POST 解析）
- [x] W4 gateway 注册路由 + 入站链路
- [x] W5 出站发送（客服消息 API）
- [x] W6 accounts 完善
- [x] W7 security
- [x] W8 pairing.notifyApproval
- [x] W9 status/probe（可选）
- [ ] W10 单元/集成测试（可选）
- [x] W11 文档 wechat-mp.md 完善

### 共用

- [x] C1 统一 Inbound 流程（finalizeInboundContext + dispatchReplyWithBufferedBlockDispatcher + deliver）
- [x] C2 各频道 target 格式与 agentPrompt 说明
- [x] C3 媒体上传/发送策略（按平台，当前仅文本）
- [x] C4 敏感配置环境变量支持
- [x] C5 日志与错误规范
- [ ] C6 CHANGELOG 与版本（按发布流程）
