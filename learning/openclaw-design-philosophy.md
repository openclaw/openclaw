# OpenClaw 设计哲学：从消息到行动的完整解剖

> 一份面向新手的架构设计原理深度解析 | 2026-02-27

---

## 引言：为什么需要理解设计哲学

学习一个系统，最重要的不是记住它有哪些文件、哪些函数，而是理解**每一个设计决策背后的"为什么"**。

OpenClaw 的核心使命是：**让 AI Agent 能通过任何消息渠道接收指令，自主操作计算机完成任务，并将结果送回**。

这个使命决定了它的四层架构：

```
┌──────────────────────────────────────────────────────┐
│  输入层 (Input Layer)                                 │
│  Telegram / Discord / Slack / 飞书 / WhatsApp / ...  │
└──────────────────┬───────────────────────────────────┘
                   │ 标准化消息
┌──────────────────▼───────────────────────────────────┐
│  网关层 (Gateway)                                     │
│  路由 · 会话管理 · 生命周期 · 健康监控                  │
└──────────────────┬───────────────────────────────────┘
                   │ 路由后的会话上下文
┌──────────────────▼───────────────────────────────────┐
│  智能体层 (Agent)                                     │
│  系统提示词 · LLM推理 · 工具调用 · Skill · 子智能体    │
└──────────────────┬───────────────────────────────────┘
                   │ 持久化
┌──────────────────▼───────────────────────────────────┐
│  存储层 (Storage)                                     │
│  会话记录 · 向量记忆 · 配置 · 媒体文件                  │
└──────────────────────────────────────────────────────┘
```

接下来，我们用一个**完整的真实例子**来穿透每一层。

---

## 第一章：一个完整例子的全程追踪

### 场景

> 你在飞书（Feishu/Lark）上给 OpenClaw 发了一条消息：
>
> "帮我把桌面上的 report.docx 转换成 PDF，然后发给我"

我们来追踪这条消息从发出到你收到 PDF 的完整旅程。

---

### 第1站：输入层 — 消息的诞生与标准化

```
你的飞书客户端
    │
    ▼
飞书服务器 (Webhook/Event Subscription)
    │
    ▼
OpenClaw 飞书频道插件 (extensions/feishu 或类似)
    │  接收 HTTP 回调
    │  提取：发送者ID、聊天ID、消息文本、附件
    │  转换为统一的 MsgContext
    ▼
标准化的内部消息
```

**关键设计决策：为什么要做"标准化"？**

每个消息平台的 API 格式都不同：

- 飞书用 `open_id` 标识用户，消息体是 JSON 嵌套结构
- Telegram 用 `chat_id` + `message_id`，消息体是扁平文本
- Discord 用 `channel_id` + `author.id`，支持 embed 富文本

如果不做标准化，后面的每一层都要写 if/else 处理各个平台的差异。这违反了**关注点分离(Separation of Concerns)** 原则。

所以 OpenClaw 定义了一个统一的 `MsgContext`：

```typescript
// 伪代码，展示核心字段
MsgContext = {
  Channel: "feishu"              // 哪个渠道
  From: "user_abc123"            // 谁发的
  To: "bot_xyz789"               // 发给谁
  FromName: "张三"                // 发送者显示名
  ChatType: "direct"             // 私聊还是群聊
  Text: "帮我把桌面上的..."       // 消息正文
  Attachments: []                // 附件（图片、文件等）
  SessionKey: "agent:default:feishu:direct:user_abc123"
  ReplyToId: undefined           // 是否回复某条消息
}
```

**设计原则：适配器模式 (Adapter Pattern)**

每个频道插件就是一个"适配器"，把外部世界的千变万化翻译成内部的统一语言。这样，Agent 层完全不需要知道消息来自飞书还是 Telegram — 它只看到标准化的 `MsgContext`。

---

### 第2站：频道插件架构 — 一个频道如何接入

OpenClaw 用**插件化架构**管理所有频道。每个频道实现同一个接口：

```typescript
ChannelPlugin = {
  id: "feishu"                    // 唯一标识
  meta: { label: "飞书", ... }    // 展示信息

  // 各个适配器：每个负责一个关注点
  config:    ChannelConfigAdapter     // 账号配置（token、webhook地址）
  gateway:   ChannelGatewayAdapter    // 启停监听（webhook服务器/轮询）
  outbound:  ChannelOutboundAdapter   // 发送消息（文本、图片、文件）
  security:  ChannelSecurityAdapter   // 权限控制（谁能发消息给Bot）
  threading: ChannelThreadingAdapter  // 回复模式（是否回复原消息）
  mentions:  ChannelMentionAdapter    // @提及 处理
  status:    ChannelStatusAdapter     // 健康检查
  actions:   ChannelMessageActionAdapter  // 特殊动作（投票、按钮等）
}
```

**为什么拆成这么多小的 Adapter？**

这是**接口隔离原则 (Interface Segregation Principle, ISP)** 的体现：

- 不是所有频道都支持投票（actions），iMessage 就不支持
- 不是所有频道都有线程概念（threading），WhatsApp 没有
- 不是所有频道都需要 @提及 去噪（mentions）

把它们拆开，每个频道只实现自己支持的能力，不需要实现的就留空。这比一个巨大的"上帝接口"灵活得多。

**核心频道 vs 扩展频道**

```
核心频道（随主包分发）：
  src/telegram/     — Telegram Bot
  src/discord/      — Discord Bot
  src/slack/        — Slack App
  src/signal/       — Signal Messenger
  src/imessage/     — iMessage (macOS)
  src/web/          — WhatsApp Web

扩展频道（独立插件包）：
  extensions/msteams/   — Microsoft Teams
  extensions/matrix/    — Matrix 协议
  extensions/zalo/      — Zalo (越南)
  extensions/irc/       — IRC
  extensions/googlechat/ — Google Chat
```

扩展频道通过插件注册 API 接入：

```typescript
// extensions/feishu/index.ts（假设的飞书插件）
export default {
  id: "feishu",
  register(api: OpenClawPluginApi) {
    api.registerChannel({ plugin: feishuPlugin });
  },
};
```

**设计原则：开放-封闭原则 (Open-Closed Principle)**

系统对"添加新频道"是开放的（写个插件就行），对"修改核心代码"是封闭的（不需要改 gateway 或 agent 代码）。

---

### 第3站：网关层 — 消息的中枢调度

当标准化消息到达网关，三件关键事情依次发生：

#### 3.1 路由决策：这条消息该谁处理？

```
resolveAgentRoute({
  cfg: 全局配置
  channel: "feishu"
  accountId: "default"
  peer: { kind: "direct", id: "user_abc123" }
})
```

路由系统按优先级查找匹配的规则：

```
优先级（从高到低）：
  1. binding.peer        → 为这个特定用户绑定的Agent
  2. binding.peer.parent → 线程继承（父消息的绑定）
  3. binding.guild+roles → 按群组+角色绑定（Discord特有）
  4. binding.guild       → 按群组绑定
  5. binding.team        → 按团队绑定（Slack）
  6. binding.account     → 按渠道账号绑定
  7. binding.channel     → 按整个渠道绑定
  8. default             → 默认Agent
```

**为什么需要这么多层路由？**

考虑这个场景：你有两个 Agent，一个专门处理工作事务（work-agent），一个处理私人助理任务（personal-agent）。你希望：

- 飞书工作群 → work-agent
- 飞书私聊 → personal-agent
- Discord 某个特定频道 → work-agent
- 其他所有 → personal-agent

这种灵活的多层路由就是为了支持**一套系统服务多个 Agent、多个场景**的需求。

#### 3.2 会话键生成：如何识别"同一个对话"

路由决策的输出包含一个关键产物 — **SessionKey**：

```
agent:default:feishu:direct:user_abc123
  │       │      │      │        │
  │       │      │      │        └── 对话对象ID
  │       │      │      └── 对话类型（私聊/群聊）
  │       │      └── 渠道
  │       └── Agent ID
  └── 固定前缀
```

**为什么 SessionKey 这么重要？**

SessionKey 是整个系统的**记忆锚点**。你今天给 Bot 发"帮我转PDF"，明天再发"上次那个文件呢"，系统能关联这两次对话，靠的就是 SessionKey 相同。

SessionKey 的设计遵循两个原则：

1. **确定性**：同一个人在同一个渠道发消息，永远生成相同的 Key
2. **隔离性**：不同人、不同渠道、不同群的 Key 互不相同

#### 3.3 消息入队与分发

```
dispatchInboundMessage({
  ctx: MsgContext          // 标准化消息
  cfg: OpenClawConfig      // 全局配置
  dispatcher: ReplyDispatcher  // 并发控制 + 打字状态管理
})
```

网关还负责：

- **防抖 (Debouncing)**：用户连续快速发送多条消息，合并为一条处理
- **并发控制**：同一会话不会同时运行两个 Agent 实例
- **打字状态**：在渠道上显示"正在输入..."

**设计原则：网关是"哑管道"**

网关不做任何"聪明"的事情 — 它不理解消息内容，不做 AI 推理。它只负责：

1. 把消息路由到正确的 Agent
2. 管理会话生命周期
3. 把 Agent 的回复送回正确的渠道

这是**单一职责原则 (Single Responsibility Principle)** 的严格遵循。

---

### 第4站：Agent 层 — 智慧的核心

消息到达 Agent 层后，真正的"思考"开始了。

#### 4.1 系统提示词构建：Agent 的"人格"与"能力边界"

在调用 LLM 之前，系统需要组装一个完整的系统提示词 (System Prompt)。这是 Agent 的"灵魂"。

```
buildAgentSystemPrompt() 的输出结构：

┌─ 身份定义 ──────────────────────────────────────────┐
│ "你是运行在 OpenClaw 中的个人助手。"                   │
└─────────────────────────────────────────────────────┘
┌─ 工具列表 ──────────────────────────────────────────┐
│ 你可以使用以下工具：                                    │
│  · exec — 执行Shell命令                               │
│  · read/write/edit — 文件读写                          │
│  · browser — 控制浏览器                                │
│  · message — 发送消息                                  │
│  · web_search/web_fetch — 搜索和抓取网页               │
│  · cron — 定时任务                                     │
│  · image — 图像分析                                    │
│  · ...                                                │
└─────────────────────────────────────────────────────┘
┌─ 安全边界 ──────────────────────────────────────────┐
│ · 不追求自我保存                                       │
│ · 不绕过安全限制                                       │
│ · 安全优先于任务完成                                    │
└─────────────────────────────────────────────────────┘
┌─ Skill 索引 ────────────────────────────────────────┐
│ 可用技能：github, npm, 1password, mintlify, ...       │
│ → 回复前先扫描可用技能，选最匹配的一个读取并执行         │
└─────────────────────────────────────────────────────┘
┌─ 记忆提示 ──────────────────────────────────────────┐
│ 回答历史问题前先查询 memory_search                     │
└─────────────────────────────────────────────────────┘
┌─ 工作目录 & 沙箱信息 ──────────────────────────────┐
│ 工作目录：/Users/tal/...                              │
│ 沙箱状态：Docker容器 / 无沙箱                          │
└─────────────────────────────────────────────────────┘
┌─ 项目上下文（AGENTS.md / MEMORY.md 等）──────────────┐
│ 从工作区加载的项目级指令和记忆                           │
└─────────────────────────────────────────────────────┘
```

**为什么系统提示词要这么复杂？**

因为 LLM 本身是"无状态的" — 每次调用都是一张白纸。系统提示词就是每次调用时给 LLM 的"完整简报"，告诉它：

1. **你是谁**（身份）
2. **你能做什么**（工具列表）
3. **你不能做什么**（安全边界）
4. **你知道什么**（记忆和上下文）
5. **你在哪里**（工作环境）

#### 4.2 工具系统：Agent 的"双手"

Agent 的智慧通过**工具调用 (Tool Use)** 转化为行动。OpenClaw 的工具系统分几类：

```
代码/文件工具：
  · read    — 读文件内容
  · write   — 创建/覆写文件
  · edit    — 精确编辑文件（查找替换）
  · grep    — 搜索文件内容
  · find    — 按模式查找文件
  · ls      — 列出目录

执行工具：
  · exec    — 执行Shell命令（支持交互式PTY）
  · process — 管理后台执行会话

浏览器/桌面工具：
  · browser     — 控制浏览器（打开/截图/点击/输入）
  · app_control — 打开macOS应用、监控日志
  · canvas      — 控制节点画布（远程UI）
  · nodes       — 访问Pi节点（摄像头/屏幕）

通讯工具：
  · message        — 发送消息和渠道动作（投票/按钮）
  · sessions_send  — 跨会话发送消息
  · sessions_spawn — 创建子Agent会话
  · subagents      — 管理子Agent

网络工具：
  · web_search — 网页搜索
  · web_fetch  — 抓取网页内容

系统工具：
  · cron    — 定时任务和唤醒事件
  · gateway — 重启/更新/配置网关
  · image   — 视觉分析图像
```

**每个工具的定义结构：**

```typescript
interface AgentTool {
  name: string; // 工具名（snake_case）
  label: string; // 显示名
  description: string; // 给LLM看的描述
  parameters: JSONSchema; // 参数的JSON Schema
  ownerOnly?: boolean; // 是否仅主人可用
  execute: (toolCallId, args) => Promise<AgentToolResult>;
}
```

**为什么用 JSON Schema 定义参数？**

因为 LLM 的工具调用协议（Function Calling）就是基于 JSON Schema 的。LLM 看到 Schema，就知道需要传什么参数。这是**契约式设计 (Design by Contract)** — 工具和 LLM 之间有明确的接口契约。

#### 4.3 回到我们的例子：Agent 的思考过程

LLM 收到用户消息 "帮我把桌面上的 report.docx 转换成 PDF，然后发给我" 后，它的推理过程大致是：

```
第1轮（思考）：
  "用户要转换Word为PDF。我需要：
   1. 先确认文件存在
   2. 用命令行工具转换
   3. 把PDF发回给用户"

第1轮（行动）→ 调用工具：
  exec({
    command: "ls ~/Desktop/report.docx"
  })

第1轮（结果）：
  "/Users/tal/Desktop/report.docx"  ← 文件存在
```

```
第2轮（思考）：
  "文件存在。用 LibreOffice 或 pandoc 转换为 PDF。"

第2轮（行动）→ 调用工具：
  exec({
    command: "libreoffice --headless --convert-to pdf --outdir /tmp ~/Desktop/report.docx"
  })

第2轮（结果）：
  "convert /Users/tal/Desktop/report.docx -> /tmp/report.pdf using filter..."
```

```
第3轮（思考）：
  "转换成功。现在需要把 PDF 发送给用户。
   用 message 工具发送文件附件。"

第3轮（行动）→ 调用工具：
  message({
    action: "send",
    text: "已经转换完成，这是你的PDF文件：",
    attachments: [{ path: "/tmp/report.pdf" }]
  })

第3轮（结果）：
  "消息已发送"
```

```
第4轮（最终回复）：
  "已将 report.docx 转换为 PDF 并发送给你了。"
```

**这就是 Agent Loop（智能体循环）的核心模式：**

```
┌─────────────┐
│   用户消息   │
└──────┬──────┘
       ▼
┌─────────────┐     ┌──────────────┐
│  LLM 推理   │────▶│  工具调用     │
└──────┬──────┘     └──────┬───────┘
       │                    │
       │    ┌───────────────┘
       │    ▼
       │  ┌──────────────┐
       │  │  工具执行结果  │
       │  └──────┬───────┘
       │         │
       ▼         ▼
┌─────────────────────┐
│ LLM 再次推理        │ ← 带着工具结果继续思考
│ (可能继续调用工具)    │
└──────────┬──────────┘
           │
    循环直到 LLM 决定
    "不需要更多工具了"
           │
           ▼
┌─────────────────────┐
│   最终文本回复        │
└─────────────────────┘
```

**为什么是循环而不是单次调用？**

因为真实任务往往需要多步操作。转换一个文件至少需要：确认文件存在 → 转换 → 发送。如果只允许一次工具调用，Agent 就无法完成任何非平凡的任务。

这个循环叫做 **ReAct 模式**（Reasoning + Acting）：LLM 先推理(Reason)再行动(Act)，看到结果后再推理再行动，直到任务完成。

---

### 第5站：工具执行层 — 操作计算机的细节

#### 5.1 exec 工具：Shell命令执行

当 Agent 调用 `exec` 执行 `libreoffice --headless --convert-to pdf ...` 时：

```
exec 工具内部流程：
  1. 安全检查 — 命令是否在允许范围内
  2. 工作目录 — 切换到Agent的workspace目录
  3. PTY分配 — 创建伪终端（支持交互式命令）
  4. 执行 — 在子进程中运行命令
  5. 超时监控 — 默认2分钟超时
  6. 输出捕获 — stdout + stderr 合并返回
  7. 退出码检查 — 非0退出码标记为错误
```

**为什么用 PTY 而不是简单的 child_process？**

因为有些命令（如 vim、ssh、docker exec -it）需要交互式终端。PTY（伪终端）让 Agent 能与交互式命令对话，比如输入密码、选择选项。

#### 5.2 browser 工具：浏览器自动化

```
browser 工具能力：
  · start      — 启动浏览器实例
  · navigate   — 跳转到URL
  · screenshot — 截屏（返回图片给LLM分析）
  · click      — 在坐标(x,y)处点击
  · type       — 键盘输入文本
  · scroll     — 滚动页面
  · stop       — 关闭浏览器
```

**为什么 Agent 需要"看"屏幕？**

有些操作无法通过命令行完成，比如填写网页表单、操作 GUI 应用。通过截屏 → LLM 分析图像 → 定位元素坐标 → 点击/输入，Agent 获得了像人一样"看屏幕操作"的能力。

这就是 **Computer Use** 的核心原理：视觉感知(截屏) + 空间推理(定位) + 动作执行(点击/输入)。

#### 5.3 message 工具：消息发送

当 Agent 调用 `message` 发送 PDF 给用户时：

```
message 工具内部流程：
  1. 解析动作类型 — "send"
  2. 构建 ReplyPayload — { text, attachments: [{path}] }
  3. 选择频道 — 回复到原始消息所在的频道（飞书）
  4. 加载出站适配器 — feishuPlugin.outbound
  5. 文本分块 — 如果文本超长，按频道限制分块
  6. 文件上传 — 把 /tmp/report.pdf 上传到飞书的文件服务
  7. 发送 — 调用飞书 API 发送带附件的消息
  8. 确认 — 返回发送结果（messageId等）
```

**出站流的关键设计：消息自动路由回源**

Agent 不需要指定"发到飞书"还是"发到Telegram" — 它只说"发回给用户"，系统自动根据 SessionKey 找到原始消息的来源渠道。这是**最小知识原则 (Least Knowledge Principle)** 的体现：Agent 不需要知道渠道细节。

---

### 第6站：存储层 — 记忆与持久化

#### 6.1 会话记录 (Session Transcript)

每次对话都以 JSONL（每行一个JSON对象）格式持久化：

```
文件位置：~/.openclaw/agents/{agentId}/sessions/{sessionId}.jsonl

内容示例：
{"type":"message","message":{"role":"user","content":"帮我把report.docx转成PDF","timestamp":1709020800000}}
{"type":"message","message":{"role":"assistant","content":[{"type":"tool_use","name":"exec","input":{"command":"ls ~/Desktop/report.docx"}}],"timestamp":1709020801000}}
{"type":"message","message":{"role":"tool_result","content":"report.docx","timestamp":1709020802000}}
{"type":"message","message":{"role":"assistant","content":"已转换完成并发送给你。","timestamp":1709020810000}}
```

**为什么用 JSONL 而不是 SQLite 或 JSON？**

| 方案      | 写入       | 读取       | 并发安全     | 增量追加 |
| --------- | ---------- | ---------- | ------------ | -------- |
| JSON 文件 | 每次全量写 | 全量加载   | 差           | 不支持   |
| SQLite    | 事务写     | 查询灵活   | 需锁         | 好       |
| **JSONL** | **追加写** | **流式读** | **天然安全** | **完美** |

JSONL 的优势在于：

1. **追加即安全**：写入时只在文件末尾追加一行，即使程序崩溃，已写入的数据不丢
2. **流式读取**：不需要把整个文件加载到内存，可以逐行读取
3. **人类可读**：直接用 `cat` 或 `jq` 就能查看
4. **Git友好**：每行是独立的，diff 非常清晰

这对于"对话记录"这种**只追加、偶尔全量读取**的数据模式是最合适的。

#### 6.2 会话元数据 (Session Store)

```
文件位置：~/.openclaw/agents/{agentId}/sessions/sessions.json

内容结构：
{
  "agent:default:feishu:direct:user_abc123": {
    "sessionId": "sess_abc123",
    "sessionFile": "~/.openclaw/agents/default/sessions/sess_abc123.jsonl",
    "updatedAt": 1709020810000,
    "channel": "feishu",
    "totalTokens": 15420,
    "inputTokens": 12000,
    "outputTokens": 3420,
    "compactionCount": 0,
    "thinkingLevel": "default",
    "modelOverride": null
  }
}
```

**元数据和记录为什么分开存？**

这是**热数据/冷数据分离**的经典模式：

- **元数据(sessions.json)**：小、经常读（每次消息都要查），放在一个文件里快速加载
- **对话内容(.jsonl)**：大、只在处理该会话时才读，按会话分文件

#### 6.3 向量记忆 (Vector Memory)

```
存储位置：~/.openclaw/agents/{agentId}/memory/index-vector.sqlite

表结构：
  · meta    — 元数据键值对
  · files   — 已索引的文件（路径、哈希、时间）
  · chunks  — 文本块 + 向量嵌入
  · chunks_fts  — 全文搜索索引（BM25）
  · chunks_vec  — 向量相似度搜索
  · embedding_cache — 嵌入缓存
```

**为什么需要"向量记忆"而不只是保存对话历史？**

对话历史是按时间排列的。当你问"上周我让你处理的那个关于财报的事"时：

- 按时间搜索 → 需要遍历整周的对话，效率低
- **按语义搜索** → 把"财报"转成向量，在向量空间中找最相似的记忆，精确高效

**混合搜索（Hybrid Search）的设计：**

```
用户查询："上次那个财报的事"
         │
    ┌────┴────┐
    ▼         ▼
  向量搜索   关键词搜索(BM25)
  (语义相似)  (精确匹配"财报")
    │         │
    └────┬────┘
         ▼
    混合排序(Hybrid Ranking)
         │
         ▼
    Top-K 结果返回给 Agent
```

**为什么要混合？**

- 向量搜索擅长**语义相近**的匹配（"财务报告" ≈ "财报"）
- 关键词搜索擅长**精确词汇**匹配（"report.docx" 必须包含这个词）
- 两者互补，结果更准确

#### 6.4 时间衰减 (Temporal Decay)

记忆不是永远同等重要的。一个月前的对话，重要性应该低于昨天的。

```
衰减公式（概念性）：
  relevance = similarity_score × decay_factor(age)

  其中 decay_factor = e^(-λ × days_since_creation)
```

这模拟了人类记忆的**遗忘曲线** — 越久远的记忆越模糊，除非它特别重要（相似度很高）。

---

## 第二章：核心设计模块深度解析

### 2.1 Skill 系统：可组合的能力模块

#### 什么是 Skill？

Skill 是一个 **Markdown 文件**，描述了 Agent 在特定场景下应该如何行动。

```
~/.openclaw/skills/
├── github/
│   └── SKILL.md          — GitHub 操作技能
├── npm/
│   └── SKILL.md          — NPM 发布技能
├── mintlify/
│   └── SKILL.md          — 文档编写技能
└── 1password/
    └── SKILL.md          — 密码管理技能
```

一个 SKILL.md 的结构：

```markdown
---
invocation: auto # 触发方式：auto/manual/always
requires:
  bins: [gh] # 需要的命令行工具
  env: [GITHUB_TOKEN] # 需要的环境变量
---

# GitHub 操作

当用户要求创建PR、查看Issue、管理Release时，使用以下步骤：

1. 先用 `gh auth status` 确认登录状态
2. 使用 `gh` CLI 执行操作
3. 操作完成后返回链接

## 创建 Pull Request

...

## 查看 Issue

...
```

#### Skill 的加载机制

```
Agent 启动时：
  1. 扫描工作区的 skills/ 目录
  2. 解析每个 SKILL.md 的 frontmatter
  3. 检查 eligibility（需要的二进制/环境变量/配置是否满足）
  4. 按 agent.skills 白名单过滤
  5. 构建技能索引，注入系统提示词

Agent 收到消息时：
  1. 系统提示词包含所有可用 Skill 的简短列表
  2. LLM 看到列表后，选择最匹配的 Skill
  3. 用 read 工具读取完整的 SKILL.md
  4. 按照 SKILL.md 的指令执行
```

**为什么不把所有 Skill 内容都塞进系统提示词？**

因为**上下文窗口是稀缺资源**。如果有 100 个 Skill，每个 2000 字，就是 20 万字的系统提示词 — 不仅浪费 token，还会"稀释"LLM 的注意力。

所以 OpenClaw 采用**懒加载策略**：

- 系统提示词只包含 Skill 名称和简短描述（索引）
- LLM 根据当前任务选择需要的 Skill
- 只有被选中的 Skill 才被完整读取

这就像图书馆的**目录卡片** vs **整本书** — 你先看目录卡片找到想要的书，再去书架取书来读。

#### Skill 数量限制

```typescript
maxCandidatesPerRoot: 300; // 每个根目录最多扫描300个
maxSkillsLoadedPerSource: 200; // 每个来源最多加载200个
maxSkillsInPrompt: 150; // 系统提示词最多包含150个
maxSkillsPromptChars: 30000; // Skill索引最多30000字符
maxSkillFileBytes: 256000; // 单个SKILL.md最大256KB
```

这些限制防止 Skill 系统"吃掉"太多上下文窗口。

---

### 2.2 AGENTS.md / CLAUDE.md：项目级行为指令

#### 设计思路

AGENTS.md 是**项目级别**的 Agent 行为指令文件，放在项目根目录或 Agent 工作区。

**类比**：如果 Skill 是"工具使用手册"，那 AGENTS.md 就是"公司员工手册" — 它定义了在这个项目/工作区中的整体行为规范。

```markdown
# AGENTS.md 典型内容

## 编码规范

- 使用 TypeScript，避免 any
- 文件不超过 500 行
- 用 Oxlint 格式化

## 提交规范

- 用 scripts/committer 提交
- 消息格式：module: description

## 安全规范

- 不提交 .env 文件
- 不暴露真实手机号

## 测试要求

- 改动逻辑代码后运行 pnpm test
- 覆盖率不低于 70%
```

#### 为什么需要 AGENTS.md？

**核心问题**：LLM 每次调用都是"无状态的"。如果你今天告诉它"用 pnpm 不要用 npm"，明天的新对话它就忘了。

**解决方案**：把持久的行为规范写在 AGENTS.md 中，每次会话都自动注入系统提示词。

**AGENTS.md vs CLAUDE.md 的区别：**

|        | AGENTS.md                                  | CLAUDE.md              |
| ------ | ------------------------------------------ | ---------------------- |
| 作用域 | OpenClaw 项目特有                          | 通用 Claude Agent 指令 |
| 内容   | 编码规范、工作流、安全规则                 | 工具使用偏好、通用行为 |
| 约定   | OpenClaw 新增的                            | Claude 生态通用        |
| 关系   | 通常 `CLAUDE.md` 是 `AGENTS.md` 的符号链接 |

```bash
# 典型设置
ln -s AGENTS.md CLAUDE.md
```

#### 层级覆盖

AGENTS.md 支持多层级：

```
全局：~/.openclaw/AGENTS.md          # 所有Agent共享
Agent级：~/.openclaw/agents/work/AGENTS.md  # 特定Agent
项目级：/project/AGENTS.md           # 特定项目
目录级：/project/src/AGENTS.md       # 特定子目录
```

内层覆盖外层，这是**配置层叠 (Configuration Cascading)** 的设计模式。

---

### 2.3 Memory 设计：三层记忆模型

OpenClaw 的记忆系统借鉴了认知心理学的记忆分层理论：

```
┌─────────────────────────────────────────────────┐
│  即时记忆 (Immediate Context)                     │
│  = 当前对话的消息历史（在LLM的上下文窗口中）         │
│  特点：精确、完整、但容量有限（取决于模型上下文窗口）  │
│  类比：人的工作记忆（Working Memory）                │
└─────────────┬───────────────────────────────────┘
              │ 超出上下文窗口时
              ▼
┌─────────────────────────────────────────────────┐
│  短期记忆 (Session Memory)                        │
│  = 会话JSONL文件中的完整历史                        │
│  特点：完整保存、按需加载、可压缩                     │
│  类比：人的短期记忆（几天到几周）                     │
└─────────────┬───────────────────────────────────┘
              │ 语义索引后
              ▼
┌─────────────────────────────────────────────────┐
│  长期记忆 (Vector Memory)                         │
│  = SQLite中的向量嵌入 + MEMORY.md 文件              │
│  特点：语义检索、跨会话、时间衰减                     │
│  类比：人的长期记忆（几个月到永久）                    │
└─────────────────────────────────────────────────┘
```

**为什么需要三层？**

- **即时记忆**足够处理当前对话中的上下文引用（"刚才那个文件"）
- **短期记忆**让 Agent 在会话重启后恢复上下文（"继续昨天的工作"）
- **长期记忆**让 Agent 跨越很久之前的对话找到关联（"三个月前你提到过一个方案..."）

#### 记忆压缩 (Memory Compaction)

当一个会话的对话历史太长，超出 LLM 上下文窗口时：

```
触发条件：token 使用量超过 softThresholdTokens

压缩流程：
  1. 用一次独立的 LLM 调用，总结旧对话
  2. 生成压缩摘要
  3. 用摘要替代原始的旧消息
  4. 旧消息保留在 JSONL 文件中（不丢失）
  5. 但发送给 LLM 时只用摘要

效果：
  原始：[消息1][消息2]...[消息500][消息501]...[消息1000]
  压缩后：[旧对话摘要][消息501]...[消息1000]
```

这就像人类的记忆巩固过程 — 睡一觉后，细节模糊了，但要点还记得。

---

### 2.4 工具策略 (Tool Policy)：分层的权限控制

不是所有 Agent 都应该拥有所有工具。OpenClaw 用分层策略控制工具访问：

```
策略层级（优先级从高到低）：
  1. 全局策略      config.tools.policy
  2. 提供商策略    config.tools.byProvider["anthropic"]
  3. 模型策略      config.tools.byProvider["anthropic/claude-3"]
  4. Agent策略     agents[].tools.policy
  5. 群聊策略      group.tools.policy
  6. 沙箱策略      agents[].sandbox.tools
  7. 子Agent策略   按嵌套深度自动限制
```

**子Agent的工具限制特别值得注意：**

```
主Agent（深度0）：拥有所有工具
  └── 子Agent（深度1）：
        禁止：gateway, cron, memory_*, sessions_send
        原因：子Agent不应该能重启网关或修改定时任务
        └── 叶子Agent（深度2+）：
              额外禁止：sessions_spawn, sessions_list
              原因：防止无限递归生成子Agent
```

**为什么要限制子Agent？**

这是**最小权限原则 (Principle of Least Privilege)** 的应用。一个被委派去"搜索网页"的子Agent，不应该有能力重启整个网关。权限范围应该与任务范围匹配。

---

### 2.5 LLM 提供商与认证轮转

OpenClaw 支持多个 LLM 提供商：

```
支持的提供商：
  · Anthropic (Claude)  — 默认
  · OpenAI (GPT)
  · Google (Gemini)
  · AWS Bedrock
  · BytePlus
  · Ollama (本地模型)
  · 自定义 OpenAI 兼容端点
```

#### 认证轮转 (Auth Profile Rotation)

```
Agent 配置中可以有多个认证配置：

profiles: [
  { name: "primary",   apiKey: "sk-xxx..." },
  { name: "fallback1", apiKey: "sk-yyy..." },
  { name: "fallback2", apiKey: "sk-zzz..." }
]

调用链：
  primary → 成功 → 使用primary
  primary → 失败(限流/额度耗尽) → fallback1
  fallback1 → 失败 → fallback2
  fallback2 → 失败 → 报错
```

**为什么需要多配置轮转？**

- API 限流（Rate Limiting）：单个 Key 每分钟请求数有限
- 额度管理：不同 Key 可能有不同的额度/计费
- 高可用性：一个 Key 出问题不影响服务

这是**断路器模式 (Circuit Breaker Pattern)** 的变体。

---

## 第三章：设计哲学总结

### 3.1 核心设计原则映射

| 原则              | OpenClaw 中的体现                   |
| ----------------- | ----------------------------------- |
| **关注点分离**    | 输入层/网关/Agent/存储 四层分离     |
| **适配器模式**    | 每个频道插件是一个适配器            |
| **开放-封闭**     | 添加新频道不需要改核心代码          |
| **接口隔离**      | ChannelPlugin 拆成多个小 Adapter    |
| **单一职责**      | 网关只路由不推理，Agent只推理不路由 |
| **最小知识**      | Agent 不知道消息来自哪个渠道        |
| **最小权限**      | 子Agent权限随深度递减               |
| **契约式设计**    | 工具用JSON Schema定义接口           |
| **配置层叠**      | AGENTS.md从全局到目录多层覆盖       |
| **热/冷数据分离** | 会话元数据vs对话内容分文件          |
| **懒加载**        | Skill索引vs完整内容延迟读取         |
| **断路器**        | LLM认证轮转和模型降级               |

### 3.2 为什么这些设计选择是好的？

**1. 插件化频道 → 生态可扩展**

任何人都可以为新的消息平台写一个插件，不需要理解整个系统。这让 OpenClaw 能快速覆盖全球各种消息平台（从 Telegram 到 Zalo）。

**2. 标准化消息 → 复杂度可控**

没有标准化，N 个频道 × M 个功能 = N×M 种实现。有了标准化，只需要 N 个适配器 + M 个功能 = N+M 种实现。

**3. JSONL 会话 → 可靠性优先**

对于"对话记录不能丢"这个核心需求，JSONL 的追加写特性提供了最好的保障。

**4. 混合记忆 → 兼顾精确和模糊**

关键词搜索找到"精确的"，向量搜索找到"相关的"，两者结合覆盖更多场景。

**5. Skill 懒加载 → 上下文效率最优**

在 LLM 有限的上下文窗口中，只加载需要的指令，让每个 token 都物有所值。

---

## 第四章：完整消息流总览图

回到我们的飞书转PDF例子，这是完整的数据流：

```
飞书客户端
  │ "帮我把report.docx转成PDF"
  ▼
飞书 Webhook ──────────────────────────── [输入层]
  │ HTTP POST { sender, chat, text }
  ▼
频道插件 (feishu plugin)
  │ 标准化为 MsgContext
  ▼
路由引擎 ──────────────────────────────── [网关层]
  │ resolveAgentRoute()
  │ → agentId: "default"
  │ → sessionKey: "agent:default:feishu:direct:user_abc123"
  ▼
会话管理器
  │ 加载/创建会话
  │ 读取历史消息
  ▼
Agent Runner ──────────────────────────── [Agent层]
  │
  ├─ 构建系统提示词
  │   └── 身份 + 工具列表 + Skill索引 + 安全边界 + 记忆
  │
  ├─ 组装消息（系统提示词 + 历史 + 新消息）
  │
  ├─ 调用 LLM（Claude/GPT/...）
  │   └── 返回：tool_use(exec, "ls ~/Desktop/report.docx")
  │
  ├─ 执行工具 ─────────────────────────── [工具执行]
  │   └── exec → Shell子进程 → "report.docx"
  │
  ├─ 结果返回 LLM → 再次调用
  │   └── 返回：tool_use(exec, "libreoffice --convert-to pdf ...")
  │
  ├─ 执行工具
  │   └── exec → Shell子进程 → "/tmp/report.pdf"
  │
  ├─ 结果返回 LLM → 再次调用
  │   └── 返回：tool_use(message, {send, attachments:["/tmp/report.pdf"]})
  │
  ├─ 执行工具
  │   └── message → 出站适配器 → 飞书API → 发送PDF文件
  │
  ├─ 结果返回 LLM → 最终回复
  │   └── "已转换并发送给你了"
  │
  └─ 最终回复 → 出站流 → 飞书API
                                          │
会话持久化 ──────────────────────────────── [存储层]
  │ 整个对话追加到 .jsonl
  │ 更新 sessions.json 元数据
  │ 异步：新内容进入向量索引
  ▼
完成
```

---

## 附录：关键源码文件索引

| 模块         | 关键文件                               | 作用                         |
| ------------ | -------------------------------------- | ---------------------------- |
| 网关入口     | `src/gateway/server.impl.ts`           | 网关启动、插件加载、通道管理 |
| 路由引擎     | `src/routing/resolve-route.ts`         | 消息路由决策                 |
| 会话键       | `src/routing/session-key.ts`           | SessionKey 生成规则          |
| 频道插件接口 | `src/channels/plugins/types.plugin.ts` | ChannelPlugin 定义           |
| 频道注册表   | `src/channels/registry.ts`             | 核心频道元数据               |
| Agent 配置   | `src/config/types.agents.ts`           | AgentConfig 类型定义         |
| Agent 作用域 | `src/agents/agent-scope.ts`            | Agent 解析和查找             |
| 系统提示词   | `src/agents/system-prompt.ts`          | 系统提示词构建               |
| 工具工厂     | `src/agents/openclaw-tools.ts`         | 所有 OpenClaw 工具创建       |
| 工具策略     | `src/agents/pi-tools.policy.ts`        | 工具权限分层策略             |
| exec 工具    | `src/agents/bash-tools.ts`             | Shell 执行                   |
| browser 工具 | `src/agents/tools/browser-tool.ts`     | 浏览器自动化                 |
| message 工具 | `src/agents/tools/message-tool.ts`     | 消息发送                     |
| Agent 运行器 | `src/agents/pi-embedded-runner/run.ts` | Agent Loop 执行              |
| Skill 加载   | `src/agents/skills/workspace.ts`       | Skill 扫描和加载             |
| Skill 类型   | `src/agents/skills/types.ts`           | Skill 元数据定义             |
| 会话存储     | `src/config/sessions/store.ts`         | 会话读写和缓存               |
| 会话路径     | `src/config/sessions/paths.ts`         | 会话文件路径解析             |
| 记忆管理器   | `src/memory/manager.ts`                | 向量记忆搜索和索引           |
| 记忆Schema   | `src/memory/memory-schema.ts`          | SQLite 表结构                |
| 记忆压缩     | `src/auto-reply/reply/memory-flush.ts` | 上下文溢出时的压缩           |
| 出站投递     | `src/infra/outbound/deliver.ts`        | 消息出站流水线               |
| 消息分块     | `src/auto-reply/chunk.ts`              | 按渠道限制分块               |
| 媒体处理     | `src/media/parse.ts`                   | 入站媒体解析                 |
| 消息调度     | `src/auto-reply/dispatch.ts`           | 入站消息调度                 |

---

> **总结一句话**：OpenClaw 的设计哲学是 —— 用**插件化输入层**屏蔽渠道差异，用**无状态网关**做路由调度，用**ReAct Agent Loop**驱动智能决策，用**分层记忆**实现跨时间的上下文理解。每一层只做一件事，做好一件事。
