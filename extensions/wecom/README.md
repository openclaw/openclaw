# OpenClaw 企业微信（WeCom）Channel 插件

<p align="center">
  <strong>🚀 企业级双模式 AI 助手接入方案</strong>
</p>

<p align="center">
  <a href="#功能亮点">功能亮点</a> •
  <a href="#模式对比">模式对比</a> •
  <a href="#快速开始">快速开始</a> •
  <a href="#配置说明">配置说明</a> •
  <a href="#联系我">联系我</a>
</p>

<p align="center">
  🤝 与腾讯云团队共建维护 / Co-built with Tencent Cloud contributors
</p>

## 🤝 共建说明

- 本项目由 **YanHaidao** 发起并持续维护。
- 项目与 **Tencent Cloud contributors（腾讯云团队）** 共同建设，在云上部署适配、稳定性优化与文档完善方面长期协作。
- 欢迎社区通过 Issue / Pull Request 参与共建。

---

## 💡 核心价值：为什么选择本插件？

### 🏗 独创架构：Bot + Agent 双模融合

传统的企微插件通常只能在 "只能聊天的机器人 (Bot)" 和 "只能推送的自建应用 (Agent)" 之间二选一。
本插件采用 **双模并行架构**，同时压榨两种模式的极限能力：

- **Bot 通道 (智能体)**：负责 **实时对话**。提供毫秒级流式响应（打字机效果），零延迟交互。
- **Agent 通道 (自建应用)**：负责 **能力兜底**。当需要发送图片/文件、进行全员广播、或 Bot 对话超时（>6分钟）时，无缝切换到 Agent 通道接管。

### 🧩 功能特性全景

#### 1. 🗣 **沉浸式交互 (Immersive Interaction)**

- **原生流式 (Stream)**：基于 HTTP 分块传输，拒绝 "转圈等待"，体验如 ChatGPT 网页版般丝滑。
- **交互式卡片 (Card)**：支持 Button/Menu 交互回传，可构建审批、查询等复杂业务流 (Agent模式)。

#### 2. 📎 **全模态支持 (Multi-Modal)**

- **发什么都能看**：支持接收图片、文件 (PDF/Doc/Zip)、语音 (自动转文字)、视频。
- **要什么都能给**：AI 生成的图表、代码文件、语音回复，均可自动上传并推送到企微。

#### 3. 📢 **企业级触达 (Enterprise Reach)**

- **精准广播**：支持向 **部门 (Party)**、**标签 (Tag)** 或 **外部群** 批量推送消息。
- **Cronjob 集成**：通过 `openclaw cron` 命令创建任务，适合早报推送、日报提醒、服务器报警。

#### 4. 🛡 **生产级稳定 (Production Ready)**

- **容灾切换**：Bot 模式 6 分钟超时自动熔断，切换 Agent 私信送达，防止长任务回答丢失。
- **Token 自动运维**：内置 AccessToken 守护进程，自动缓存、提前刷新、过期重试。

---

## 📊 模式能力对比

| 能力维度            | 🤖 Bot 模式                 | 🧩 Agent 模式                             | ✨ **本插件 (双模)**           |
| :------------------ | :-------------------------- | :---------------------------------------- | :----------------------------- |
| **接收消息 (单聊)** | ✅ 文本/图片/语音/文件      | ✅ 文本/图片/语音/视频/位置/链接          | **✅ 全能互补** (覆盖所有类型) |
| **接收消息 (群聊)** | ✅ 文本/引用                | ❌ 不支持 (无回调)                        | **✅ 文本/引用**               |
| **发送消息**        | ❌ 仅支持文本/图片/Markdown | ✅ **全格式支持** (文本/图片/视频/文件等) | **✅ 智能路由** (自动切换)     |
| **流式响应**        | ✅ **支持** (打字机效果)    | ❌ 不支持                                 | **✅ 完美支持**                |
| **主动推送**        | ❌ 仅被动回复               | ✅ **支持** (指定用户/部门/标签)          | **✅ 完整 API**                |

---

## 快速开始

### 1. 安装插件

```bash
openclaw plugins install @openclaw/wecom
openclaw plugins enable wecom
```

也可以通过命令行向导快速配置：

```bash
openclaw config --section channels
```

### 2. 配置 Bot 模式（智能体）

```bash
openclaw config set channels.wecom.enabled true
openclaw config set channels.wecom.bot.token "YOUR_BOT_TOKEN"
openclaw config set channels.wecom.bot.encodingAESKey "YOUR_BOT_AES_KEY"
openclaw config set channels.wecom.bot.receiveId ""
openclaw config set channels.wecom.bot.streamPlaceholderContent "正在思考..."
openclaw config set channels.wecom.bot.welcomeText "你好！我是 AI 助手"

# DM 门禁（推荐显式设置 policy）
# - open: 默认放开（所有人可用）
# - disabled: 全部禁用
# - allowlist: 仅 allowFrom 允许的人可用
openclaw config set channels.wecom.bot.dm.policy "open"
# policy=allowlist 时生效（例如只允许某些 userid；"*" 表示允许所有人）
openclaw config set channels.wecom.bot.dm.allowFrom '["*"]'
```

### 3. 配置 Agent 模式（自建应用，可选）

```bash
openclaw config set channels.wecom.enabled true
openclaw config set channels.wecom.agent.corpId "YOUR_CORP_ID"
openclaw config set channels.wecom.agent.corpSecret "YOUR_CORP_SECRET"
openclaw config set channels.wecom.agent.agentId 1000001
openclaw config set channels.wecom.agent.token "YOUR_CALLBACK_TOKEN"
openclaw config set channels.wecom.agent.encodingAESKey "YOUR_CALLBACK_AES_KEY"
openclaw config set channels.wecom.agent.welcomeText "欢迎使用智能助手"
openclaw config set channels.wecom.agent.dm.policy "open"
openclaw config set channels.wecom.agent.dm.allowFrom '["*"]'
```

### 4. 高级网络配置 (公网出口代理)

如果您的服务器使用 **动态 IP** (如家庭宽带、内网穿透) 或 **无公网 IP**，企业微信 API 会因 IP 变动报错 `60020 not allow to access from your ip`。
此时需配置一个**固定 IP 的正向代理** (如 Squid)，让插件通过该代理访问企微 API。

```bash
openclaw config set channels.wecom.network.egressProxyUrl "http://proxy.company.local:3128"
```

### 5. 验证

```bash
openclaw gateway restart
openclaw channels status
```

---

## 配置说明

### 完整配置结构

```jsonc
{
  "channels": {
    "wecom": {
      "enabled": true,

      // Bot 模式配置（智能体）
      "bot": {
        "token": "YOUR_BOT_TOKEN",
        "encodingAESKey": "YOUR_BOT_AES_KEY",
        "receiveId": "", // 可选，用于解密校验
        "streamPlaceholderContent": "正在思考...",
        "welcomeText": "你好！我是 AI 助手",
        "dm": { "allowFrom": [] }, // 私聊限制
      },

      // Agent 模式配置（自建应用）
      "agent": {
        "corpId": "YOUR_CORP_ID",
        "corpSecret": "YOUR_CORP_SECRET",
        "agentId": 1000001,
        "token": "YOUR_CALLBACK_TOKEN", // 企微后台「设置API接收」
        "encodingAESKey": "YOUR_CALLBACK_AES_KEY",
        "welcomeText": "欢迎使用智能助手",
        "dm": { "allowFrom": [] },
      },

      // 网络配置（可选）
      "network": {
        "egressProxyUrl": "http://proxy.company.local:3128",
      },
    },
  },
}
```

### Webhook 路径（固定）

| 模式  | 路径           | 说明         |
| :---- | :------------- | :----------- |
| Bot   | `/wecom/bot`   | 智能体回调   |
| Agent | `/wecom/agent` | 自建应用回调 |

### DM 策略

- **不配置 `dm.allowFrom`** → 所有人可用（默认）
- **配置 `dm.allowFrom: ["user1", "user2"]`** → 白名单模式，仅列表内用户可私聊

### 常用指令

| 指令     | 说明                       | 示例                   |
| :------- | :------------------------- | :--------------------- |
| `/new`   | 🆕 开启新会话 (重置上下文) | `/new` 或 `/new GPT-4` |
| `/reset` | 🔄 重置会话 (同 /new)      | `/reset`               |

---

## 企业微信接入指南

### Bot 模式（智能机器人）

1. 登录 [企业微信管理后台](https://work.weixin.qq.com/wework_admin/frame#/manageTools)
2. 进入「安全与管理」→「管理工具」→「智能机器人」
3. 创建机器人，选择 **API 模式**
4. 填写回调 URL：`https://your-domain.com/wecom/bot`
5. 记录 Token 和 EncodingAESKey

### Agent 模式（自建应用）

1. 登录 [企业微信管理后台](https://work.weixin.qq.com/wework_admin/frame#/apps)
2. 进入「应用管理」→「自建」→ 创建应用
3. 获取 AgentId、CorpId、Secret
4. **重要：** 进入「企业可信IP」→「配置」→ 添加你服务器的 IP 地址
   - 如果你使用内网穿透/动态 IP，建议配置 `channels.wecom.network.egressProxyUrl` 走固定出口代理，否则可能出现：`60020 not allow to access from your ip`
5. 在应用详情中设置「接收消息 - 设置API接收」
6. 填写回调 URL：`https://your-domain.com/wecom/agent`
7. 记录回调 Token 和 EncodingAESKey

<div align="center">
  <img src="https://cdn.jsdelivr.net/npm/@openclaw/wecom@latest/assets/03.bot.page.png" width="45%" alt="Bot Config" />
  <img src="https://cdn.jsdelivr.net/npm/@openclaw/wecom@latest/assets/03.agent.page.png" width="45%" alt="Agent Config" />
</div>

---

## 高级功能

### A2UI 交互卡片

Agent 输出 `{"template_card": ...}` 时自动渲染为交互卡片：

- ✅ 单聊场景：发送真实交互卡片
- ✅ 按钮点击：触发 `template_card_event` 回调
- ✅ 自动去重：基于 `msgid` 避免重复处理
- ⚠️ 群聊降级：自动转为文本描述

### ⏰ Cronjob 企业级定时推送

本插件深度集成了 OpenClaw 的 Cronjob 调度能力，配合 Agent 强大的广播 API，轻松实现企业级通知服务。

> **核心场景**：早报推送、服务器报警、日报提醒、节日祝福。

#### 1. 目标配置 (Target)

无需遍历用户列表，直接利用 Agent 强大的组织架构触达能力：

| 目标类型           | 格式示例           | 推送范围        | 典型场景                     |
| :----------------- | :----------------- | :-------------- | :--------------------------- |
| **部门 (Party)**   | `party:1` (或 `1`) | 📢 **全员广播** | 全员通知、技术部周报         |
| **标签 (Tag)**     | `tag:Ops`          | 🎯 **精准分组** | 运维报警、管理层汇报         |
| **外部群 (Group)** | `group:wr...`      | 💬 **群聊推送** | 项目组群日报 (需由Agent建群) |
| **用户 (User)**    | `user:zhangsan`    | 👤 **即时私信** | 个人待办提醒                 |

#### 2. 命令行创建定时任务（推荐）

请使用 `openclaw cron` 创建/管理任务，而不是手工维护 `schedule.json` 或 `cron/jobs.json`。

示例 A：工作日早上 9:00 推送到部门 `party:1`

```bash
openclaw cron add \
  --name "wecom-morning-brief" \
  --cron "0 9 * * 1-5" \
  --tz "Asia/Shanghai" \
  --session isolated \
  --message "🌞 早安！请查收今日行业简报。" \
  --announce \
  --channel wecom \
  --to "party:1"
```

示例 B：每周五 18:00 推送到标签 `tag:Ops`

```bash
openclaw cron add \
  --name "wecom-friday-ops-reminder" \
  --cron "0 18 * * 5" \
  --tz "Asia/Shanghai" \
  --session isolated \
  --message "🔒 周五封网提醒：请检查服务器状态。" \
  --announce \
  --channel wecom \
  --to "tag:Ops"
```

常用管理命令：

```bash
openclaw cron list
openclaw cron status
openclaw cron run <jobId>
openclaw cron runs --id <jobId>
openclaw cron rm <jobId>
```

#### 3. Gateway 配置示例 (`~/.openclaw/openclaw.json`)

```json5
{
  cron: {
    enabled: true,
    store: "~/.openclaw/cron/jobs.json",
  },
}
```

---

## 📖 详细行为说明 (Behavior Detail)

### 1. 企业微信群聊交付规则

- **默认 (Bot 回复)**：群聊里 @Bot，默认由 Bot 在群内直接回复（优先文本/图片/Markdown）。
- **例外 (文件兜底)**：如果回复内容包含**非图片文件**（如 PDF/Word/表格/压缩包等），由于企微 Bot 接口不支持，插件会自动：
  1.  Bot 在群里提示："由于格式限制，文件将通过私信发送给您"。
  2.  无缝切换到 **自建应用 (Agent)** 通道，将文件私信发送给触发者。
- **提示**：若未配置 Agent，Bot 会明确提示“需要管理员配置自建应用通道”。

### 2. 长任务可靠性保障

- **超时熔断**：企业微信限制 Bot 流式回复窗口约为 6 分钟。
- **自动接力**：当对话时长接近此阈值时，Monitor 会自动截断 Bot 流，提示 "剩余内容将私信发送"，并立即启动 Agent 通道私信发送完整结果。这彻底解决了长思考任务（如深度推理、代码生成）因超时导致用户收不到结果的问题。

### 3. 主动发送安全机制

- **群发保护**：Agent 主动发送接口不再尝试向普通群 `chatid` (wr/wc...) 发消息（该路径常因权限与归属产生的隐蔽错误）。
- **引导提示**：系统会明确拦截并通过日志提示中文错误："请使用 Bot 群内交付或改为私信目标（userid/部门/标签）"，帮助管理员快速排查配置。

### 4. 管理员友好

- 所有兜底逻辑（Fallback）触发时，如果因配置缺失导致失败，Bot 都会给出清晰的**中文提示**，而不是沉默或报代码错误，极大降低了排查难度。

---

## 🙋 社区问答 (FAQ)

针对社区反馈的高频问题，我们已在 v2.2.4 版本中全部解决：

**Q1: 同时使用 Bot 和 Agent 会导致消息重复吗？**

> **A:** 不会。本插件采用“Bot 优先”策略。用户在哪个通道发消息，就从哪个通道回。只有在 Bot 无法处理（如发文件）时才会智能切换到 Agent 通道作为补充。

**Q2: 使用内网穿透时，企业微信报错 60020 (IP 不白名单) 怎么办？**

> **A:** 新增了 `config.network.egressProxyUrl` 配置。您可以配置一个拥有固定公网 IP 的代理服务器（如 Squid），让插件通过该代理与企微 API 通信，从而绕过动态 IP 限制。

**Q3: 原生 Bot 模式支持图片，为什么 Agent 模式不行？**

> **A:** Agent 模式之前确实存在此短板。但在 v2.2.4 中，我们完整实现了 Agent 端的 XML 媒体解析与 `media_id` 下载逻辑，现在 Agent 模式也能完美看图、听语音了。

**Q4: 群里 @机器人 发送文件失败？**

> **A:** 因为企业微信 Bot 接口本身不支持发送非图片文件。我们的解决方案是：自动检测到文件发送需求后，改为通过 Agent 私信该用户发送文件，并在群里给出 "文件已私信发给您" 的提示。

**Q5: 为什么在 Agent 模式下发送文件（如 PDF、Word）给机器人没有反应？**

> **A:** 这是由于企业微信官方接口限制。自建应用（Agent）的消息回调接口仅支持：文本、图片、语音、视频、位置和链接信息。**不支持**通用文件（File）类型的回调，因此插件无法感知您发送的文件。

**Q6: Cronjob 定时任务怎么发给群？**

> **A:** Cronjob 必须走 Agent 通道（Bot 无法主动发消息）。您只需在配置中指定 `to: "party:1"` (部门) 或 `to: "group:wr123..."` (外部群)，即可实现定时推送到群。

**Q7: 为什么发视频给 Bot 没反应？**

> **A:** 官方 Bot 接口**不支持接收视频**。如果您需要处理视频内容，请配置并使用 Agent 模式（Agent 支持接收视频）。

---

## 联系我

微信交流群（扫码入群）：

![企业微信交流群](https://openclaw.cc/wechat-openclaw-cn-qr.jpg)

维护者：YanHaidao（VX：YanHaidao）

---

## 更新日志

### 2026.2.9

- 📝 **文档更新**：补充“与腾讯云团队共建维护”的对外说明，优化 README 展示结构。
- 📝 **治理文档**：新增并完善 `GOVERNANCE.md`，沉淀项目协作与治理规则。
- 📝 **Cron 指引优化**：更新为 `openclaw cron` 命令方式管理定时任务，替代旧的静态 JSON 配置描述。

### 2026.2.7

- ✨ **动态 Agent 路由**：新增按用户/群组隔离的动态路由功能，支持为每个对话主体自动分配独立的 Agent 实例（如 `wecom-dm-xxx`）。
- 🛠 **自动注册机制**：动态生成的 Agent 会自动异步注册到 `agents.list` 配置中，实现多租户 Agent 的无感扩容与管理。
- 🛡 **权限与兼容性**：支持 `adminUsers` 白名单绕过机制以使用主 Agent；功能默认关闭，确保对现有配置完全兼容。
- ⚙️ **精细化配置**：新增 `channels.wecom.dynamicAgents` 配置项，可独立控制私聊和群聊的动态路由行为。
- 🙏 **特别致谢**：感谢 [WhyMeta](https://github.com/WhyMeta) 开发者对动态路由实施方案的贡献。

### 2026.2.5

- 🛠 **体验优化**：WeCom 媒体（图片/语音/视频/文件）处理的默认大小上限提升到 25MB，减少大文件因超限导致的“下载/保存失败”。
- 📌 **可配置提示**：若仍遇到 Media exceeds ... limit，日志/回复会提示通过 channels.wecom.media.maxBytes 调整上限，并给出可直接执行的 openclaw config set 示例命令。

### 2026.2.4

- 🚀 **架构升级**：实施 "Bot 优先 + Agent 兜底" 策略，兼顾流式体验与长任务稳定性（6分钟切换）。
- ✨ **全模态支持**：Agent 模式完整支持接收图片/语音/视频（文件仅支持发送）。
- ✨ **Cronjob 增强**：支持向部门 (`party:ID`) 和标签 (`tag:ID`) 广播消息。
- 🛠 **Monitor 重构**：统一的消息防抖与流状态管理，提升并发稳定性。
- 🛠 **体验优化**：修复企微重试导致的重复回复（Bot/Agent 均做 `msgid` 去重）；优化 Bot 连续多条消息的排队/合并回执，避免“重复同一答案”或“消息失败提示”。
- 🐞 **修复**：Outbound ID 解析逻辑及 API 客户端参数缺失问题。

### 2026.2.3

- 🎉 **重大更新**：新增 Agent 模式（自建应用）支持
- ✨ 双模式并行：Bot + Agent 可同时运行
- ✨ **多模态支持**：Agent 模式支持图片/语音/文件/视频的接收与自动下载
- ✨ AccessToken 自动管理：缓存 + 智能刷新
- ✨ Agent 主动推送：脱离回调限制
- ✨ XML 加解密：完整 Agent 回调支持
- 📁 代码重构：模块化解耦设计

### 2026.1.31

- 文档：补充入模与测试截图说明
- 新增文件支持
- 新增卡片支持

### 2026.1.30

- 项目更名：Clawdbot → OpenClaw
