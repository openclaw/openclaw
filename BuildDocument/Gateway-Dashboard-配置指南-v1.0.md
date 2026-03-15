# Gateway Dashboard 配置指南

> 版本：v1.0  
> 创建日期：2026-03-04  
> 文档路径：`BuildDocument/Gateway-Dashboard-配置指南-v1.0.md`  
> 配置文件路径：`~/.openclaw/openclaw.json`

---

## 前言

本文档按照**配置依赖关系**和**重要程度**确定配置顺序，从基础到高级逐步展开。  
每个配置项包含：功能说明、当前状态、配置方法、注意事项。

### 配置原则

```
基础运行 → 模型接入 → 身份定制 → 渠道接入 → 工具扩展 → 高级调优
```

### 当前配置状态（基线）

```json
{
  "commands": {
    "native": "auto",
    "nativeSkills": "auto",
    "restart": true,
    "ownerDisplay": "raw"
  },
  "gateway": {
    "auth": {
      "mode": "token",
      "token": "a6ccb20998d1a48241f0a68f98c1e9e3a93a955ee677977e"
    }
  },
  "meta": {
    "lastTouchedVersion": "2026.3.3",
    "lastTouchedAt": "2026-03-04T14:03:03.517Z"
  }
}
```

> ✅ **已完成**：Gateway 认证（Token 模式）、基础命令配置  
> 🔲 **待配置**：模型 API Key、Agents 身份、消息渠道、工具权限、Cron 任务等

---

## 配置优先级顺序总览

| 优先级 | 配置区域            | Dashboard 位置               | 状态        |
| ------ | ------------------- | ---------------------------- | ----------- |
| ★★★ 1  | Gateway 连接 / 认证 | Overview                     | ✅ 已完成   |
| ★★★ 2  | 模型提供商 API Key  | Config → Environment         | 🔲 待配置   |
| ★★★ 3  | Agent 主模型选择    | Agents → Overview            | 🔲 待配置   |
| ★★☆ 4  | Agent 身份配置      | Agents → Files (IDENTITY.md) | 🔲 待配置   |
| ★★☆ 5  | 消息渠道接入        | Config → Channels            | 🔲 待配置   |
| ★★☆ 6  | 工具权限策略        | Agents → Tools               | 🔲 待配置   |
| ★☆☆ 7  | 会话参数调整        | Sessions                     | 🔲 按需配置 |
| ★☆☆ 8  | 技能管理            | Skills                       | 🔲 按需配置 |
| ★☆☆ 9  | 定时任务            | Cron                         | 🔲 按需配置 |
| ★☆☆ 10 | 节点绑定            | Nodes                        | 🔲 按需配置 |
| ☆☆☆ 11 | 高级网关配置        | Config → Gateway             | 仅高级需求  |

---

---

# 第一步：Gateway 连接配置（Overview）

## 1.1 概述

**Dashboard 位置：** Overview 标签页 → Access 卡片  
**当前状态：** ✅ 已完成（Token 认证模式）

Overview 是 Dashboard 的入口，负责建立 Dashboard 与 Gateway 后端的 WebSocket 连接。只有成功连接后，其他所有管理功能才能使用。

## 1.2 连接参数说明

### WS URL（WebSocket 地址）

- **字段**：Gateway WebSocket 连接地址
- **格式**：`ws://IP:端口` 或 `wss://域名:端口`（HTTPS 需要 TLS）
- **本地默认**：`ws://127.0.0.1:18789`
- **当前值**：根据 `start_openclaw.sh` 脚本设定，默认监听本地端口 18789
- **说明**：如果通过 Tailscale 访问远程机器，格式为 `ws://100.x.y.z:18789`

### Token（访问令牌）

- **字段**：`OPENCLAW_GATEWAY_TOKEN` 对应的令牌值
- **当前值**：`a6ccb20998d1a48241f0a68f98c1e9e3a93a955ee677977e`
- **作用**：身份验证，防止未授权访问
- **配置方式**：在 `~/.openclaw/openclaw.json` 的 `gateway.auth.token` 中设置，或通过环境变量 `OPENCLAW_GATEWAY_TOKEN` 设置

### Session Key（会话密钥）

- **字段**：当前控制台会话的身份 Key
- **默认**：Dashboard 自动生成，留空即可
- **建议**：保持默认，除非需要在多个 Dashboard 实例间共享会话

### Language（界面语言）

- **当前**：根据浏览器默认
- **可选**：English、中文等多语言
- **建议**：选择"中文（简体）"

## 1.3 认证模式说明

Gateway 支持以下认证模式（在 Config → Authentication 配置）：

| 模式            | 说明                    | 适用场景                  |
| --------------- | ----------------------- | ------------------------- |
| `token`         | 静态令牌验证 ✅（当前） | 本地/内网访问             |
| `password`      | 密码认证                | 简单保护                  |
| `none`          | 无认证                  | 仅限完全信任的本地环境    |
| `trusted-proxy` | 信任反向代理            | Nginx/Cloudflare 前置代理 |

## 1.4 连接错误排查

| 错误类型                   | 原因             | 解决方案                                                      |
| -------------------------- | ---------------- | ------------------------------------------------------------- |
| `AUTH_TOKEN_MISMATCH`      | Token 不匹配     | 检查 Token 是否与 openclaw.json 一致                          |
| `DEVICE_IDENTITY_REQUIRED` | 非安全上下文     | 使用 HTTPS 或配置 `gateway.controlUi.allowInsecureAuth: true` |
| Connection refused         | Gateway 未启动   | 运行 `./BuildTools/start_openclaw.sh`                         |
| `AUTH_RATE_LIMITED`        | 认证失败次数过多 | 等待冷却或重启 Gateway                                        |

---

# 第二步：模型 API Key 配置（Config → Environment）

## 2.1 概述

**Dashboard 位置：** Config 标签页 → Environment 分区  
**当前状态：** 🔲 未配置（需要至少配置一个模型提供商的 API Key）

**重要性：** 这是 OpenClaw 能够调用 AI 模型的基础，**必须配置**。

## 2.2 支持的模型提供商

### 主流提供商

| 提供商            | 环境变量                             | 配置说明             |
| ----------------- | ------------------------------------ | -------------------- |
| **OpenAI**        | `OPENAI_API_KEY`                     | GPT-4o、GPT-4 等     |
| **Anthropic**     | `ANTHROPIC_API_KEY`                  | Claude 3.5 Sonnet 等 |
| **Google Gemini** | `GEMINI_API_KEY` 或 `GOOGLE_API_KEY` | Gemini 1.5/2.0 等    |
| **OpenRouter**    | `OPENROUTER_API_KEY`                 | 统一接入多个提供商   |
| **Moonshot Kimi** | 需特殊配置（见下方）                 | kimi-coding 模型     |

### 其他提供商

| 提供商     | 环境变量             |
| ---------- | -------------------- |
| ZAI (Z.ai) | `ZAI_API_KEY`        |
| DeepSeek   | 通过 OpenRouter 接入 |
| MiniMax    | `MINIMAX_API_KEY`    |

## 2.3 配置方式

### 方式一：通过 Dashboard Config 表单（推荐）

1. 打开 Dashboard → Config 标签页
2. 左侧选择 **Environment** 分区
3. 找到对应提供商的 API Key 字段
4. 输入 API Key 后点击 **Save**

### 方式二：直接编辑配置文件

在 `~/.openclaw/openclaw.json` 中添加 `env` 块：

```json
{
  "env": {
    "OPENAI_API_KEY": "sk-你的OpenAI密钥",
    "ANTHROPIC_API_KEY": "sk-ant-你的Anthropic密钥",
    "GEMINI_API_KEY": "你的Gemini密钥"
  }
}
```

> ⚠️ **安全提示**：`env` 块内容会加密存储在配置文件中，请勿将配置文件提交到 Git 仓库。

### 方式三：系统环境变量

在 `~/.openclaw/.env` 文件中设置（优先级最高）：

```bash
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
GEMINI_API_KEY=...
```

## 2.4 多 Key 负载均衡

当有多个同类型 API Key 时，可以配置负载均衡：

```json
{
  "env": {
    "OPENAI_API_KEYS": "sk-key1,sk-key2,sk-key3"
  }
}
```

## 2.5 Kimi（月之暗面）特殊配置

由于 `kimi-for-coding` 模型对请求来源有限制，需要特殊配置：

- **详见**：`skills/kimi-coding-api-bypass/SKILL.md` 或历史会话 `d012db60` 中的配置记录

---

# 第三步：Agent 主模型选择（Agents → Overview）

## 3.1 概述

**Dashboard 位置：** Agents 标签页 → 选中 Agent → Overview 子面板  
**当前状态：** 🔲 未配置（使用系统默认）

Agent 的模型决定了 AI 的能力、成本和响应速度。

## 3.2 当前 Agent 列表

当前系统有一个 Agent：

- **Agent ID**：`main`
- **位置**：`~/.openclaw/agents/main/`

## 3.3 模型选择界面说明

在 Agents → Overview 子面板的 **Model Selection** 区域：

### Primary Model（主模型）

- **作用**：该 Agent 默认使用的 AI 模型
- **格式**：`提供商/模型ID`，例如 `openai/gpt-4o`
- **默认继承**：选择"Inherit default"使用全局默认模型

### Fallbacks（备用模型）

- **作用**：主模型失败时自动切换到备用模型
- **格式**：逗号分隔的模型列表，如 `anthropic/claude-3-5-sonnet,openai/gpt-4o`
- **建议**：至少配置一个备用模型，提高稳定性

## 3.4 常用模型配置参考

| 场景       | 推荐模型                      | 说明         |
| ---------- | ----------------------------- | ------------ |
| 日常对话   | `openai/gpt-4o-mini`          | 快速、低成本 |
| 复杂编程   | `anthropic/claude-3-5-sonnet` | 代码能力强   |
| 长文本分析 | `openai/gpt-4o`               | 综合能力强   |
| 国内访问   | `moonshot/kimi-latest`        | 无需翻墙     |
| 本地隐私   | `mlx/...`（本地模型）         | 数据不出境   |

## 3.5 全局默认模型配置

通过 Config → Agents 分区的 `agents.defaults.model` 字段设置全局默认模型：

```json
{
  "agents": {
    "defaults": {
      "model": "openai/gpt-4o"
    }
  }
}
```

---

# 第四步：Agent 身份配置（Agents → Files）

## 4.1 概述

**Dashboard 位置：** Agents 标签页 → 选中 Agent → Files 子面板  
**当前状态：** 🔲 IDENTITY.md 存在但内容为模板（未填写）

身份配置决定了 Agent 的名称、性格和自我认知，影响其对话风格。

## 4.2 IDENTITY.md 配置

**文件路径**：`~/.openclaw/workspace/IDENTITY.md`  
**Dashboard 访问**：Agents → main → Files → 点击 `IDENTITY.md`

需要填写以下内容：

```markdown
# IDENTITY.md - Who Am I?

- **Name:** （给 Agent 起一个名字，如"星火"、"助理"等）
- **Creature:** （AI、助手、知识精灵等身份定位）
- **Vibe:** （性格特点：专业、温暖、幽默、严谨等）
- **Emoji:** （个性化 Emoji，如 🤖、✨、⚡ 等）
- **Avatar:** （可选：头像图片路径或 URL）
```

**配置建议：**

- Name 使用中文名，更符合中文对话习惯
- Vibe 直接影响 Agent 的回复风格，要根据实际用途来设置
- Emoji 会显示在 Dashboard Agents 列表中

## 4.3 AGENTS.md 说明

**文件路径**：`~/.openclaw/workspace/AGENTS.md`  
**作用**：定义 Agent 的行为规范、工作原则和操作规则

这是 Agent 的"宪法"文件，已有默认内容，包含：

- 记忆管理规则
- 群聊行为规范
- 工具使用指南
- 心跳（Heartbeat）机制说明

**建议**：先保留默认内容，了解 Agent 行为后再根据需要修改。

## 4.4 HEARTBEAT.md 配置

**作用**：配置 Agent 定期自动执行的检查任务  
**当前**：文件存在但可能为空

```markdown
# HEARTBEAT.md - 定期检查清单

- 检查是否有待回复的消息
- 查看日历是否有近期事项
- （添加你的自定义检查项）
```

---

# 第五步：消息渠道配置（Config → Channels）

## 5.1 概述

**Dashboard 位置：** Config 标签页 → Channels 分区  
**当前状态：** 🔲 均未配置

渠道是 AI 与外界通信的接口，配置后可通过对应平台收发消息。

> **注意**：渠道配置需要先在对应平台创建 Bot/应用并获取 Token。

## 5.2 各渠道配置说明

### 🔹 Telegram Bot

**前提**：向 @BotFather 创建 Bot，获取 Bot Token

| 配置项        | 说明                                                       |
| ------------- | ---------------------------------------------------------- |
| **Bot Token** | 格式：`123456789:ABCDEF...`（来自 BotFather）              |
| **所属配置**  | `channels.telegram.token` 或 `TELEGRAM_BOT_TOKEN` 环境变量 |

**Dashboard 配置步骤**：

1. Config → Channels 分区
2. 找到 Telegram 配置块
3. 填入 Bot Token
4. 保存后在 Channels 标签页查看连接状态

**验证**：在 Telegram 中向 Bot 发送 `/start`，Bot 应有回应。

---

### 🔹 Discord Bot

**前提**：在 Discord Developer Portal 创建 Application，添加 Bot，获取 Bot Token

| 配置项        | 说明                                                     |
| ------------- | -------------------------------------------------------- |
| **Bot Token** | Discord Bot 的访问令牌                                   |
| **所属配置**  | `channels.discord.token` 或 `DISCORD_BOT_TOKEN` 环境变量 |

**必要权限**：`Message Content Intent`（需要在 Developer Portal 手动开启）

---

### 🔹 Slack Bot

**前提**：创建 Slack App，安装到 Workspace

| 配置项        | 说明                                                  |
| ------------- | ----------------------------------------------------- |
| **Bot Token** | `xoxb-...` 格式                                       |
| **App Token** | `xapp-...` 格式（用于 Socket Mode）                   |
| **所属配置**  | `channels.slack.botToken` / `channels.slack.appToken` |

---

### 🔹 WhatsApp

**说明**：WhatsApp 集成通过 Whatsmeow 库实现，需要扫码绑定手机号。  
**限制**：仅支持个人账号，不支持 Business API（需购买）。

---

### 🔹 iMessage（仅 macOS）

**说明**：通过 macOS 的 Messages.app 发送接收消息。  
**前提**：需要在 macOS 上登录 Apple ID。

---

### 🔹 Nostr

**说明**：去中心化社交协议，需要配置密钥对（npub/nsec）。

---

## 5.3 渠道配置的三种方式

### 方式一：当前配置文件（json）

```json
{
  "channels": {
    "telegram": {
      "token": "你的Bot Token"
    }
  }
}
```

### 方式二：环境变量

```bash
# ~/.openclaw/.env
TELEGRAM_BOT_TOKEN=123456:...
DISCORD_BOT_TOKEN=...
```

### 方式三：Dashboard 表单

Config → Channels 分区 → 相应渠道字段 → Save

---

# 第六步：工具权限策略（Agents → Tools）

## 6.1 概述

**Dashboard 位置：** Agents 标签页 → 选中 Agent → Tools 子面板  
**当前状态：** 🔲 使用默认权限（未自定义）

工具权限控制 Agent 能执行哪些操作（文件操作、系统命令、网络请求等）。

## 6.2 权限体系说明

### Profile（权限预设）

| Profile      | 说明                     |
| ------------ | ------------------------ |
| `default`    | 标准权限，禁止危险操作   |
| `trusted`    | 较宽松，允许更多系统操作 |
| `restricted` | 严格限制，仅基本操作     |
| `none`       | 无工具                   |

### alsoAllow（额外允许）

在 Profile 基础上额外允许某些工具，格式为工具名列表。

### deny（明确禁止）

强制禁用某些工具，优先级高于 Profile 和 alsoAllow。

## 6.3 常见工具说明

| 工具                    | 功能            | 风险等级  |
| ----------------------- | --------------- | --------- |
| `web.search`            | 网页搜索        | 低        |
| `computer.execute_bash` | 执行 Shell 命令 | 高 ⚠️     |
| `computer.write_file`   | 写入文件        | 中        |
| `computer.read_file`    | 读取文件        | 低        |
| `email.send`            | 发送邮件        | 中        |
| `system.run`            | 系统级别命令    | 极高 ⚠️⚠️ |

## 6.4 推荐配置

**日常助手 Agent**：

```json
{
  "tools": {
    "profile": "default",
    "exec": {
      "deny": ["system.run"]
    }
  }
}
```

**开发辅助 Agent**（可执行代码）：

```json
{
  "tools": {
    "profile": "trusted"
  }
}
```

---

# 第七步：会话参数调整（Sessions）

## 7.1 概述

**Dashboard 位置：** Sessions 标签页  
**当前状态：** 按需进行，此步骤为可选调优

会话参数可以针对特定会话覆盖全局默认值，适合临时调整 AI 行为。

## 7.2 可调参数说明

### Thinking Level（思考深度）

控制 AI 在回答前"内心独白"的层次，影响回复质量，也影响 Token 消耗。

| 级别      | 说明         | Token 消耗 |
| --------- | ------------ | ---------- |
| `inherit` | 继承全局设置 | —          |
| `off`     | 关闭思考     | 最低       |
| `minimal` | 极简思考     | 低         |
| `low`     | 基础思考     | 低         |
| `medium`  | 标准思考     | 中         |
| `high`    | 深度思考     | 高         |
| `xhigh`   | 超深度思考   | 极高       |

**建议**：日常对话用 `low` 或 `medium`，复杂问题用 `high`。

### Verbose Level（输出详细度）

控制 AI 回复的详细程度。

| 级别      | 说明                 |
| --------- | -------------------- |
| `inherit` | 继承设置             |
| `off`     | 最简洁               |
| `on`      | 标准详细度           |
| `full`    | 最详细，包含更多说明 |

### Reasoning Level（推理模式）

控制是否启用链式推理步骤（部分模型支持）。

| 级别      | 说明                         |
| --------- | ---------------------------- |
| `inherit` | 继承设置                     |
| `off`     | 关闭推理步骤                 |
| `on`      | 启用推理                     |
| `stream`  | 流式推理（实时输出推理过程） |

## 7.3 操作说明

1. Sessions 标签页 → 找到目标会话行
2. 在对应列的下拉框中选择新值
3. 修改**立即生效**，无需手动保存

---

# 第八步：技能管理（Skills）

## 8.1 概述

**Dashboard 位置：** Skills 标签页  
**当前状态：** 🔲 按需启用/禁用

技能（Skills）是赋予 Agent 特定能力的插件，如网页搜索、代码执行、图片生成等。

## 8.2 技能类别说明

### 内置技能（Built-in）

随 OpenClaw 安装自带，开箱即用：

- `web.search` - 网页搜索
- `computer.*` - 文件和系统操作
- `memo.*` - 记忆管理

### 托管技能（Managed）

需要通过 Dashboard 启用，部分需要 API Key：

- `brave-search` - Brave 搜索（需要 `BRAVE_API_KEY`）
- `perplexity` - Perplexity 搜索（需要 `PERPLEXITY_API_KEY`）
- `elevenlabs` - 语音合成（需要 `ELEVENLABS_API_KEY`）

### 工作区技能（Workspace）

放置在 `~/.openclaw/workspace/skills/` 目录的自定义技能。

## 8.3 如何启用技能

1. Skills 标签页 → 找到目标技能
2. 点击 **Enable** 按钮
3. 若需要 API Key，在技能卡片右侧输入 Key 并点击 **Save key**

## 8.4 Agent 级别的技能控制

在 Agents → Skills 子面板中，可以针对特定 Agent：

- 只允许使用特定技能
- 禁用某些全局已启用的技能

---

# 第九步：定时任务配置（Cron）

## 9.1 概述

**Dashboard 位置：** Cron 标签页  
**当前状态：** 🔲 未配置（无任务）

定时任务让 Agent 定期自动执行特定操作，无需人工触发。

## 9.2 典型用例

| 用例         | 建议配置                              |
| ------------ | ------------------------------------- |
| 每日早报     | 每天 08:00，搜索新闻并发送到 Telegram |
| 定期提醒     | 每周一 09:00，发送本周计划提醒        |
| 自动检查     | 每小时检查邮件并汇报摘要              |
| 数据备份提醒 | 每周五 17:00，提醒备份重要文件        |

## 9.3 创建定时任务

在 Cron 标签页右侧的 **New Job** 表单：

**基础信息**：

- **Name（任务名称）**：必填，描述性名称
- **Description（描述）**：可选，详细说明
- **Agent ID（执行 Agent）**：指定哪个 Agent 执行，留空用默认 Agent
- **Enabled（启用）**：是否立即生效

**调度设置**（三选一）：

> **Every（间隔执行）**
>
> - 每隔 X 秒/分钟/小时执行
> - 例：每 30 分钟 → Amount: 30, Unit: minutes

> **At（固定时刻）**
>
> - 每天某个时刻执行
> - 例：每天 08:00

> **Cron Expression（Cron 表达式）**
>
> - 完整 Cron 表达式语法
> - 例：`0 8 * * 1-5`（工作日早上 8 点）

**执行设置**：

- **Session Target**：`main`（在主会话中运行）或 `isolated`（独立新会话）
  - `main`：有上下文记忆，共享历史
  - `isolated`：干净环境，适合独立任务
- **Payload Text**：发给 Agent 的任务描述/提示词
- **Model Override**：可为此任务使用不同模型

**投递设置**：

- **Delivery Mode**：`none`（不主动投递）、`announce`（发到渠道）、`webhook`（调用 Webhook）
- **Delivery To**：目标渠道 ID 或 Webhook URL

## 9.4 心跳（Heartbeat）与 Cron 的区别

| 特性     | Heartbeat         | Cron         |
| -------- | ----------------- | ------------ |
| 触发方式 | Gateway 定期 Ping | 独立调度器   |
| 上下文   | 共享主会话历史    | 可独立       |
| 时间精度 | 近似（±几分钟）   | 精确（秒级） |
| 适合场景 | 周期性检查批处理  | 精确时间任务 |

---

# 第十步：节点绑定（Nodes）

## 10.1 概述

**Dashboard 位置：** Nodes 标签页  
**当前状态：** 🔲 无远程节点（本机运行）

Nodes 功能用于将 Agent 的命令执行绑定到特定的远程计算节点，适合多机部署场景。

## 10.2 适用场景

- 有多个服务器，需要让 Agent 在特定机器上执行命令
- 隔离不同 Agent 的执行环境
- 将高计算量任务分配给性能更强的机器

## 10.3 设备配对

1. 在远程设备上安装 OpenClaw 并启动
2. 远程设备会自动发送配对请求
3. 在 Dashboard → Nodes → Devices 中审批：点击 **Approve**
4. 审批后设备出现在 "Paired" 列表

## 10.4 执行节点绑定

1. 先在 Config 标签页加载配置（点击 "Load config"）
2. 为默认执行节点选择目标机器
3. 可为每个 Agent 单独设置执行节点
4. 点击 **Save** 保存绑定关系

> **本地单机部署**：此步骤可以跳过。

---

# 第十一步：高级 Gateway 配置（Config → Gateway）

## 11.1 概述

**Dashboard 位置：** Config 标签页 → Gateway 分区  
**当前状态：** 使用默认值，无需修改（除非有特殊需求）

## 11.2 主要配置项

### 绑定设置

```json
{
  "gateway": {
    "bind": "loopback", // 监听范围：loopback（本机）/ network（内网）/ public（公网）
    "port": 18789, // 监听端口（默认 18789）
    "host": "0.0.0.0" // 监听地址（bind=network/public 时生效）
  }
}
```

⚠️ **安全警告**：`bind: network` 或 `bind: public` 会将 Gateway 暴露到网络，务必配合 `auth.token` 使用！

### Control UI 设置

```json
{
  "gateway": {
    "controlUi": {
      "enabled": true, // 是否启用 Dashboard
      "allowInsecureAuth": false // 是否允许 HTTP 下使用认证（不推荐）
    }
  }
}
```

### Tailscale 集成（可选）

```json
{
  "gateway": {
    "tailscale": {
      "enabled": true,
      "mode": "serve" // serve（仅内网）或 funnel（公网）
    }
  }
}
```

### OpenAI 兼容 API

```json
{
  "gateway": {
    "openAiChatCompletions": {
      "enabled": true // 将 Gateway 作为 OpenAI 兼容端点
    }
  }
}
```

---

# 附录：配置文件完整结构参考

以下是推荐的 `~/.openclaw/openclaw.json` 完整结构（按配置优先级排列）：

```json
{
  // 第一步：Gateway 认证（已配置）
  "gateway": {
    "auth": {
      "mode": "token",
      "token": "你的Token"
    },
    "bind": "loopback",
    "controlUi": {
      "enabled": true
    }
  },

  // 第二步：模型 API Key
  "env": {
    "OPENAI_API_KEY": "sk-...",
    "ANTHROPIC_API_KEY": "sk-ant-...",
    "GEMINI_API_KEY": "...",
    "TELEGRAM_BOT_TOKEN": "123456:..."
  },

  // Agents 全局默认配置（第三步）
  "agents": {
    "defaults": {
      "model": "openai/gpt-4o",
      "tools": {
        "profile": "default"
      }
    }
  },

  // 渠道配置（第五步）
  "channels": {
    "telegram": {
      "enabled": true
    }
  },

  // 命令配置（已配置）
  "commands": {
    "native": "auto",
    "nativeSkills": "auto",
    "restart": true,
    "ownerDisplay": "raw"
  },

  // 元数据（自动维护）
  "meta": {
    "lastTouchedVersion": "2026.3.3",
    "lastTouchedAt": "2026-03-04T14:03:03.517Z"
  }
}
```

---

## 配置记录日志

| 日期       | 配置步骤 | 操作内容                     | 操作人     |
| ---------- | -------- | ---------------------------- | ---------- |
| 2026-03-04 | 第一步   | 完成 Gateway Token 认证配置  | 系统初始化 |
| —          | 第二步   | 待配置：模型 API Key         | —          |
| —          | 第三步   | 待配置：Agent 主模型         | —          |
| —          | 第四步   | 待配置：IDENTITY.md 身份文件 | —          |
| —          | 第五步   | 待配置：消息渠道             | —          |

---

_本文档随配置进度持续更新。新增配置时，请在"配置记录日志"中记录操作内容。_
