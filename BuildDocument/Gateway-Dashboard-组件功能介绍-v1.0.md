# Gateway Dashboard 组件功能介绍

> 版本：v1.0  
> 创建日期：2026-03-04  
> 项目：OpenClaw Gateway  
> 文档路径：`BuildDocument/Gateway-Dashboard-组件功能介绍-v1.0.md`

---

## 概述

Gateway Dashboard（控制台 UI）是 OpenClaw Gateway 的 Web 管理界面，通过 WebSocket 与 Gateway 后端实时通信。界面由多个功能标签页（Tab）组成，每个标签页对应一个独立的管理组件。

主要标签页导航结构：

| 标签页   | 源文件              | 主要功能            |
| -------- | ------------------- | ------------------- |
| Overview | `views/overview.ts` | 连接状态与服务快照  |
| Sessions | `views/sessions.ts` | 会话管理与参数调整  |
| Channels | `views/channels.ts` | 消息渠道状态管理    |
| Agents   | `views/agents.ts`   | AI Agent 配置与监控 |
| Cron     | `views/cron.ts`     | 定时任务管理        |
| Config   | `views/config.ts`   | Gateway 配置编辑    |
| Skills   | `views/skills.ts`   | 技能插件管理        |
| Nodes    | `views/nodes.ts`    | 节点与设备管理      |
| Logs     | `views/logs.ts`     | 实时日志查看        |
| Debug    | `views/debug.ts`    | 调试与诊断工具      |

---

## 1. Overview（概览）

**源文件：** `ui/src/ui/views/overview.ts`

Overview 是进入 Dashboard 的第一个页面，分为三个区域：

### 1.1 Access（连接配置）卡片

这是 Dashboard 连接 Gateway 的入口配置区域，包含以下输入字段：

| 字段            | 说明                                                                     |
| --------------- | ------------------------------------------------------------------------ |
| **WS URL**      | Gateway 的 WebSocket 地址，格式如 `ws://100.x.y.z:18789`                 |
| **Token**       | Gateway 访问令牌（`OPENCLAW_GATEWAY_TOKEN`），trusted-proxy 模式下不显示 |
| **Password**    | 系统密码或共享密码，trusted-proxy 模式下不显示                           |
| **Session Key** | 当前会话的 Key，用于标识连接身份                                         |
| **Language**    | 界面语言选择（支持多种 Locale）                                          |

操作按钮：

- **Connect**：按当前配置发起 WebSocket 连接
- **Refresh**：刷新连接状态

**错误提示逻辑：**  
当连接失败时，会根据错误类型显示不同的引导提示：

- `AUTH_REQUIRED` / `AUTH_TOKEN_MISSING`：提示用户生成 token 或通过 tokenized URL 访问
- `AUTH_UNAUTHORIZED` / `AUTH_UNAUTHORIZED`：提示认证失败，引导查看文档
- `DEVICE_IDENTITY_REQUIRED`：提示需要安全上下文，建议切换 HTTPS 或配置 `allowInsecureAuth`
- 设备配对错误：显示 `openclaw devices list` / `openclaw devices approve` 引导命令

### 1.2 Snapshot（服务快照）卡片

展示当前 Gateway 的运行状态：

| 指标                      | 说明                                           |
| ------------------------- | ---------------------------------------------- |
| **Status**                | 连接状态：`OK`（绿色）或 `Offline`（黄色警告） |
| **Uptime**                | Gateway 已运行时长（人性化格式）               |
| **Tick Interval**         | Gateway 心跳周期（毫秒）                       |
| **Last Channels Refresh** | 上次渠道状态刷新的相对时间戳                   |

### 1.3 统计卡片（三列）

| 卡片          | 说明                                         |
| ------------- | -------------------------------------------- |
| **Instances** | 当前在线的 Gateway 实例数量（presence 计数） |
| **Sessions**  | 当前活跃会话总数                             |
| **Cron**      | 定时任务启用状态及下次执行时间               |

### 1.4 Notes（备注说明）卡片

包含三个操作指引：

- **Tailscale**：介绍如何通过 Tailscale 安全连接
- **Session**：说明 Session Key 的作用
- **Cron**：说明定时任务功能

---

## 2. Sessions（会话管理）

**源文件：** `ui/src/ui/views/sessions.ts`

Sessions 页面展示当前 Gateway 上的所有活跃会话，并支持对每个会话进行参数覆写。

### 2.1 过滤器

| 过滤器                      | 说明                               |
| --------------------------- | ---------------------------------- |
| **Active within (minutes)** | 只显示在指定时间范围内有活动的会话 |
| **Limit**                   | 最多返回多少条会话记录             |
| **Include global**          | 是否包含全局会话（global kind）    |
| **Include unknown**         | 是否包含未知类型会话               |

### 2.2 会话列表（表格）

每行代表一个会话，包含以下列：

| 列名          | 说明                                                                                       |
| ------------- | ------------------------------------------------------------------------------------------ |
| **Key**       | 会话唯一标识符（可点击跳转到对应 Chat 页面）                                               |
| **Label**     | 自定义标签（可编辑，用于标识会话用途）                                                     |
| **Kind**      | 会话类型（如 `global`、`isolated` 等）                                                     |
| **Updated**   | 最近更新的相对时间                                                                         |
| **Tokens**    | 该会话已消耗的 Token 数量                                                                  |
| **Thinking**  | 思考模式（inherit / off / minimal / low / medium / high / xhigh），ZAI 提供商简化为 on/off |
| **Verbose**   | 详细输出级别（inherit / off / on / full）                                                  |
| **Reasoning** | 推理模式（inherit / off / on / stream）                                                    |
| **Actions**   | 操作按钮（Delete 删除该会话）                                                              |

> **说明：** 所有下拉框修改后会实时发送 Patch 请求到 Gateway，无需手动保存。

---

## 3. Channels（渠道管理）

**源文件：** `ui/src/ui/views/channels.ts` 及各渠道子文件

Channels 页面集中管理所有消息渠道的状态与配置，支持以下渠道：

| 渠道        | 源文件                   |
| ----------- | ------------------------ |
| WhatsApp    | `channels.whatsapp.ts`   |
| Telegram    | `channels.telegram.ts`   |
| Discord     | `channels.discord.ts`    |
| Google Chat | `channels.googlechat.ts` |
| Slack       | `channels.slack.ts`      |
| Signal      | `channels.signal.ts`     |
| iMessage    | `channels.imessage.ts`   |
| Nostr       | `channels.nostr.ts`      |

### 3.1 渠道卡片

每个渠道以卡片形式展示，显示：

- **Configured**：是否已配置
- **Running**：进程是否运行中
- **Connected**：是否已连接到对端服务器
- **Last inbound**：最近收到消息的时间
- **Last error**：最近出现的错误信息（若有）

渠道卡片按"已启用"的渠道优先显示，排序基于 `channelMeta` 或 `channelOrder` 配置。

**智能状态判断：**  
若 `running` 为 false，但 10 分钟内有入站消息（`lastInboundAt`），则状态显示为 `Active`（表示实际上仍在工作）。

### 3.2 Nostr 特殊配置

Nostr 渠道额外支持身份档案编辑功能：

- 显示 Nostr Profile（昵称、头像、bio 等）
- 支持导入/保存 Profile
- 支持高级配置切换

### 3.3 Channel Health（渠道健康状态）

页面底部有一个独立的"Channel Health"卡片，以 JSON 格式展示 Gateway 返回的完整渠道快照数据，便于排查问题。

---

## 4. Agents（Agent 管理）

**源文件：** `ui/src/ui/views/agents.ts` 及子面板文件

Agents 页面采用左右布局：左侧为 Agent 列表，右侧为选中 Agent 的详细管理面板。

### 4.1 Agent 列表（左侧边栏）

- 显示所有已配置的 Agent
- 每行展示：Emoji/首字母头像、Agent 名称、Agent ID
- 默认 Agent 顶部显示 `default` 徽章
- 点击 Agent 后，右侧展示该 Agent 的详情

### 4.2 Agent 详情（右侧主区域）

Agent 详情区域顶部展示选中 Agent 的头像、名称、主题描述和 ID，然后是 6 个子标签页：

#### 4.2.1 Overview（概览）子面板

展示工作区元数据：

| 字段               | 说明                                       |
| ------------------ | ------------------------------------------ |
| **Workspace**      | Agent 的工作目录路径                       |
| **Primary Model**  | 当前使用的主模型名称                       |
| **Identity Name**  | Agent 身份名称（来自 Identity 配置或文件） |
| **Default**        | 是否为默认 Agent                           |
| **Identity Emoji** | Agent 的 Emoji 标识符                      |
| **Skills Filter**  | 该 Agent 启用的技能数量或"all skills"      |

**模型选择区域：**

- **Primary model**：下拉选择主模型，支持继承默认值
- **Fallbacks**：输入备用模型列表（逗号分隔），模型失败时自动切换
- **Reload Config / Save** 按钮：重新加载或保存配置

#### 4.2.2 Files（文件）子面板

用于浏览和编辑 Agent 工作区内的文件：

- 显示文件列表（技能文件、配置文件等）
- 点击文件查看内容
- 支持内联编辑文件内容
- **Reset**：丢弃未保存的修改
- **Save**：将文件保存到 Agent 工作区

#### 4.2.3 Tools（工具）子面板

管理 Agent 可使用的工具：

- 选择工具权限 Profile（预设策略集合）
- 配置 `alsoAllow`（额外允许的工具）和 `deny`（禁止的工具）列表
- 提供工具目录（Tools Catalog）参考，列出所有可用工具
- 修改后需手动点击 Save 保存

#### 4.2.4 Skills（技能）子面板

管理 Agent 级别的技能：

- 显示该 Agent 所有可用技能及其状态
- 支持搜索过滤技能
- 可对单个技能进行 **Enable / Disable** 切换
- **Clear**：清除 Agent 的技能覆写设置（恢复全局默认）
- **Disable All**：禁用该 Agent 的所有技能

#### 4.2.5 Channels（渠道）子面板

查看该 Agent 的渠道接入情况：

- 展示与该 Agent 关联的渠道快照
- 显示各渠道的运行状态、连接状态
- 提供刷新按钮获取最新状态

#### 4.2.6 Cron Jobs（定时任务）子面板

查看与该 Agent 相关的定时任务：

- 显示该 Agent 的所有 Cron Job 列表
- 展示每个任务的调度状态、下次执行时间
- 提供刷新按钮获取最新状态

---

## 5. Cron（定时任务）

**源文件：** `ui/src/ui/views/cron.ts`

Cron 页面是定时任务的完整管理中心，采用工作区布局（左主右表单）。

### 5.1 状态摘要条

页面顶部显示 Cron 系统的全局状态：

| 字段          | 说明                                        |
| ------------- | ------------------------------------------- |
| **Enabled**   | 整个 Cron 系统是否启用（绿色/红色状态芯片） |
| **Jobs**      | 当前已配置的任务总数                        |
| **Next Wake** | 下次唤醒检查的时间                          |

### 5.2 Jobs 列表（任务列表）

支持多维度过滤与排序：

| 过滤器        | 选项                                                |
| ------------- | --------------------------------------------------- |
| **搜索**      | 按名称或关键字搜索                                  |
| **Enabled**   | All / Enabled / Disabled                            |
| **Schedule**  | All / At（固定时刻）/ Every（间隔）/ Cron（表达式） |
| **Last Run**  | All / OK / Error / Skipped                          |
| **Sort by**   | Next Run / Recently Updated / Name                  |
| **Direction** | Ascending / Descending                              |

每个任务行显示：名称、调度表达式、下次运行时间、上次运行状态，以及 **Edit / Clone / Toggle / Run / Delete** 操作按钮。

### 5.3 Runs 日志（执行历史）

展示所有任务或选定任务的历史执行记录，支持过滤：

| 过滤器       | 说明                                                |
| ------------ | --------------------------------------------------- |
| **Scope**    | All Jobs（全部）/ Selected Job（选定任务）          |
| **搜索**     | 按关键字搜索                                        |
| **Status**   | OK / Error / Skipped                                |
| **Delivery** | Delivered / Not Delivered / Unknown / Not Requested |
| **Sort**     | Newest First / Oldest First                         |

### 5.4 表单区域（新建/编辑任务）

任务创建/编辑表单包含以下分组：

**Basics（基础）**

- 任务名称（必填）
- 描述
- Agent ID（指定执行任务的 Agent）
- 是否启用

**Schedule（调度）**

- 调度类型：
  - `Every`：每隔 N 秒/分钟/小时
  - `At`：固定时刻（如 09:00）
  - `Cron`：标准 Cron 表达式
- Stagger Window（随机延迟窗口，避免并发）

**Execution（执行）**

- Session Target：`main`（主会话）或 `isolated`（独立隔离会话）
- Payload Kind：`agentTurn`（Agent 轮次）或 `systemEvent`（系统事件）
- 任务提示文本或事件消息
- 指定模型（可覆盖 Agent 默认设置）
- Thinking 模式覆盖
- Timeout（超时秒数）

**Delivery（投递）**

- 投递模式：`none` / `announce` / `webhook`
- 投递目标（渠道 ID 或 Webhook URL）
- 失败告警配置（多少次失败后告警、冷却时间）

---

## 6. Config（配置编辑）

**源文件：** `ui/src/ui/views/config.ts`

Config 页面是 Gateway 配置的完整编辑界面，采用左侧导航 + 右侧内容布局。

### 6.1 左侧侧边栏

**搜索栏：**

- 支持按关键字搜索所有配置项
- 支持 Tag 过滤（预设标签：`security` / `auth` / `network` / `access` / `privacy` / `observability` / `performance` / `reliability` / `storage` / `models` / `media` / `automation` / `channels` / `tools` / `advanced`）

**分区导航（Section Nav）：**

| 分区           | 说明              |
| -------------- | ----------------- |
| All Settings   | 显示所有配置项    |
| Environment    | 环境变量相关配置  |
| Updates        | 版本更新配置      |
| Agents         | Agent 相关配置    |
| Authentication | 认证方式配置      |
| Channels       | 渠道配置          |
| Messages       | 消息处理配置      |
| Commands       | 命令配置          |
| Hooks          | 事件钩子配置      |
| Skills         | 技能系统配置      |
| Tools          | 工具权限配置      |
| Gateway        | 核心 Gateway 配置 |
| Setup Wizard   | 初始设置向导      |

**模式切换（底部）：**

- **Form 模式**：基于 JSON Schema 渲染的可视化表单，支持子分区导航
- **Raw 模式**：直接编辑原始 JSON5 配置文本

### 6.2 右侧操作栏

| 按钮       | 说明                                 |
| ---------- | ------------------------------------ |
| **Reload** | 从 Gateway 重新加载当前配置          |
| **Save**   | 将修改保存到 Gateway（配置文件写入） |
| **Apply**  | 保存并立即应用（触发配置重载）       |
| **Update** | 在线更新 Gateway 本身                |

**变更预览（Diff Panel）：**  
Form 模式下，若有未保存的修改，会显示差异对比面板，列出每个变更项目的 `路径 → 旧值 → 新值`，便于确认修改范围。

---

## 7. Skills（技能管理）

**源文件：** `ui/src/ui/views/skills.ts`

Skills 页面展示并管理 Gateway 全局级别的技能插件。

### 7.1 技能列表

支持：

- 按名称/描述/来源过滤技能
- 显示已筛选的技能数量

技能按分组展示（`<details>` 折叠组件）：

- **Managed**（托管技能）：默认展开
- **Workspace**（工作区技能）：默认折叠
- **Built-in**（内置技能）：默认折叠

### 7.2 单个技能卡片

| 字段             | 说明                               |
| ---------------- | ---------------------------------- |
| **名称 + Emoji** | 技能标识                           |
| **描述**         | 技能功能简介                       |
| **状态芯片**     | Enabled / Disabled / Missing 等    |
| **Missing**      | 缺少的依赖（如外部命令、环境变量） |
| **Reason**       | 无法启用的原因（若有）             |

操作：

- **Enable / Disable**：切换技能的启用状态
- **Install**：若技能有安装向导（如依赖缺失），提供安装按钮
- **API Key 输入**：若技能需要 API Key（`primaryEnv` 字段），显示密码输入框和 Save Key 按钮

---

## 8. Nodes（节点与设备管理）

**源文件：** `ui/src/ui/views/nodes.ts`

Nodes 页面管理与 Gateway 相连的计算节点和已配对的移动/桌面设备。

### 8.1 Exec Node Binding（执行节点绑定）

用于将 Agent 绑定到指定的执行节点（当工具执行命令 `exec host=node` 时生效）：

- **Default binding**：所有 Agent 的默认执行节点（"Any node" 表示不限定）
- **各 Agent 绑定**：可为每个 Agent 单独指定节点，覆盖默认值

> **前提：** 需先在 Config 标签页中加载配置，且目标节点需支持 `system.run` 能力。

### 8.2 Devices（设备配对）

管理设备的配对请求与已配对设备列表：

**Pending（待审批）：**

- 显示请求设备名称、设备 ID、IP 地址、请求时间、角色
- 提供 **Approve**（批准）和 **Reject**（拒绝）按钮

**Paired（已配对）：**

- 显示已配对设备名称、ID、IP、角色、作用域
- 每个设备显示其 Token 列表，每个 Token 显示：角色、状态（active/revoked）、作用域、时间戳
- 提供 **Rotate**（轮换密钥）和 **Revoke**（撤销）按钮

### 8.3 Nodes（节点列表）

展示已连接的计算节点：

| 字段          | 说明                                                       |
| ------------- | ---------------------------------------------------------- |
| **名称**      | 节点显示名称或 Node ID                                     |
| **Node ID**   | 唯一标识符                                                 |
| **Remote IP** | 节点的远程 IP 地址                                         |
| **Version**   | 节点软件版本                                               |
| **状态芯片**  | `paired` / `unpaired` · `connected`（绿）/ `offline`（黄） |
| **Caps**      | 节点能力列表（如 `system.run`）                            |
| **Commands**  | 节点支持的命令列表                                         |

---

## 9. Logs（日志查看）

**源文件：** `ui/src/ui/views/logs.ts`

Logs 页面提供 Gateway 文件日志（JSONL 格式）的实时查看功能。

### 9.1 工具栏

| 控件                   | 说明                         |
| ---------------------- | ---------------------------- |
| **Refresh**            | 手动刷新日志内容             |
| **Export**             | 将当前筛选结果导出为文本文件 |
| **Filter 输入框**      | 按消息内容/子系统搜索日志    |
| **Auto-follow 复选框** | 启用后自动滚动到最新日志行   |

### 9.2 日志级别过滤

提供 6 个日志级别的切换复选框（组件样式带颜色标识）：

| 级别    | 说明             |
| ------- | ---------------- |
| `trace` | 最详细的跟踪信息 |
| `debug` | 调试信息         |
| `info`  | 普通信息         |
| `warn`  | 警告信息         |
| `error` | 错误信息         |
| `fatal` | 致命错误         |

### 9.3 日志流

日志以行格式展示：

```
[时间]  [级别]  [子系统]  [消息内容]
```

- 日志较多时自动截断，显示提示"Log output truncated; showing latest chunk."
- 关闭 Auto-follow 后可手动滚动查看历史

---

## 10. Debug（调试工具）

**源文件：** `ui/src/ui/views/debug.ts`

Debug 页面为开发者和高级用户提供底层诊断工具。

### 10.1 Snapshots（快照）

展示三组原始 JSON 数据（`<pre>` 格式）：

- **Status**：Gateway 当前状态快照，包含运行时信息
  - 若包含 `securityAudit` 字段，会以彩色 callout 显示安全审计摘要（critical/warn/info 级别）
  - 引导用户执行 `openclaw security audit --deep` 获取详情
- **Health**：Gateway 健康检查数据
- **Last heartbeat**：最近一次心跳包数据

### 10.2 Manual RPC（手动 RPC）

允许直接向 Gateway 发送任意 RPC 调用：

| 字段              | 说明                                          |
| ----------------- | --------------------------------------------- |
| **Method**        | 调用的 Gateway 方法名（如 `system-presence`） |
| **Params (JSON)** | 方法参数，JSON 格式的文本输入区               |
| **Call 按钮**     | 发送请求并在下方展示结果或错误信息            |

> 适合排查特定 API 行为或测试 Gateway 接口。

### 10.3 Models（模型目录）

以 JSON 格式展示 `models.list` 接口返回的所有可用模型目录，包含每个模型的 Provider、ID、能力等信息。

### 10.4 Event Log（事件日志）

展示 Dashboard 本地捕获的最近 Gateway 事件流：

- 显示事件名称和发生时间
- 以 `<pre>` 格式展示每个事件的 Payload 数据
- 便于实时观察 Gateway 推送的事件（如 session 更新、channel 状态变化等）

---

## 附：组件关系图

```
Gateway Dashboard
├── Overview        ← 连接入口、服务状态
├── Sessions        ← 会话管理（参数覆写）
├── Channels        ← 消息渠道状态
│   ├── WhatsApp
│   ├── Telegram
│   ├── Discord
│   ├── Google Chat
│   ├── Slack
│   ├── Signal
│   ├── iMessage
│   └── Nostr
├── Agents          ← Agent 管理（6个子面板）
│   ├── Overview    ← 工作区与模型配置
│   ├── Files       ← 文件浏览与编辑
│   ├── Tools       ← 工具权限配置
│   ├── Skills      ← 技能启用/禁用
│   ├── Channels    ← Agent 渠道视角
│   └── Cron Jobs   ← Agent 定时任务
├── Cron            ← 全局定时任务管理
│   ├── Jobs        ← 任务列表与过滤
│   ├── Runs        ← 历史执行记录
│   └── Form        ← 新建/编辑任务
├── Config          ← 配置编辑器（Form/Raw 双模式）
│   ├── Environment
│   ├── Agents
│   ├── Authentication
│   ├── Channels
│   ├── ...
│   └── Gateway
├── Skills          ← 全局技能管理
├── Nodes           ← 节点与设备管理
│   ├── Exec Bindings
│   ├── Devices
│   └── Nodes List
├── Logs            ← 实时日志查看
└── Debug           ← 调试工具
    ├── Snapshots
    ├── Manual RPC
    ├── Models
    └── Event Log
```

---

_文档基于源代码分析生成，反映 OpenClaw 当前版本的 Dashboard 实现。_
