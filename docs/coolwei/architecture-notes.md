# OpenClaw 架构笔记

## 1. server-methods-list.ts 的作用

`src/gateway/server-methods-list.ts` 是 gateway 服务器的"方法与事件注册表"。

- `BASE_METHODS` 数组列出 gateway 支持的所有 RPC 方法名（如 `health`、`config.get`、`send`、`chat.send` 等）
- `listGatewayMethods()` 将基础方法与各 channel 插件动态注册的方法合并去重，作为 gateway 对外暴露的完整方法列表
- `GATEWAY_EVENTS` 数组列出 gateway 可以推送给客户端的所有事件类型（如 `agent`、`chat`、`shutdown`、`heartbeat` 等）

本质上是 gateway 的"能力清单"，HTTP/WebSocket 层在路由请求时用这个列表校验方法是否合法。

## 2. 这些方法的消费者

不只是前端。Gateway 是统一的 RPC 服务器，所有客户端走同一套 WebSocket 方法列表：

- **CLI 客户端** — `openclaw` 命令行工具通过 WebSocket 调用（如 `config.get`、`channels.status`、`send`）
- **Web UI（Control UI）** — 浏览器端管理界面通过 WebSocket 调用同一套方法
- **远程节点（Node）** — 其他机器上的 openclaw 实例通过 `node.pair.*`、`node.invoke`、`node.event` 等通信
- **移动端设备** — 通过 `device.pair.*`、`device.token.*` 配对和认证
- **WebChat 客户端** — 通过 `chat.send`、`chat.history`、`chat.abort` 实时聊天
- **Channel 插件** — 各插件通过 `listChannelPlugins()` 动态注册自己的方法

`attachGatewayWsHandlers` 把方法列表注册到 WebSocket 层，收到请求时根据方法名分发到对应 handler。

## 3. Gateway 如何使用 AI Agent

### 调用链路

1. **`src/gateway/server-methods/agent.ts`** — 入口。客户端通过 WebSocket 发送 `agent` 方法请求（带 message、agentId、sessionKey 等参数），handler 负责参数校验、session 解析、delivery 路由，然后调用 `agentCommand`。

2. **`src/commands/agent.ts`** — 编排层。`agentCommand` 解析 session、加载 workspace、解析 model/provider（支持 session 级别的 model override）、构建 skills snapshot、处理 thinking level，最终调用 `runEmbeddedPiAgent`。

3. **`src/agents/pi-embedded.ts` → `src/agents/pi-embedded-runner/run.ts`** — AI 执行层。`runEmbeddedPiAgent` 把 prompt、session 文件、model 配置等传给底层 Pi agent 引擎，拿到流式响应和最终 payloads。

4. **结果回传** — `agentCommand` 通过 `deliverAgentCommandResult` 把回复投递出去（WebSocket 推回客户端，或通过 channel 发到 Telegram/Discord 等）。

### 其他触发 AI 的路径

- `src/auto-reply/` — channel 消息（Telegram、Discord 等）进来后走 trigger handling，也调用 `runEmbeddedPiAgent`
- `src/cron/isolated-agent/run.ts` — 定时任务触发 agent 运行，同样调用 `runEmbeddedPiAgent`

`runEmbeddedPiAgent`（在 `src/agents/pi-embedded.ts`）是所有 AI 调用的汇聚点。

## 4. 调用 AI 使用的库

项目使用 `@mariozechner/pi-ai` 和 `@mariozechner/pi-coding-agent` 这套自研 agent 框架（作者 Mario Zechner）：

- **`@mariozechner/pi-ai`** — 提供 `streamSimple` 函数，负责与 AI 模型的流式通信
- **`@mariozechner/pi-coding-agent`** — 提供 `createAgentSession`、`SessionManager`、`SettingsManager` 等，是 coding agent 的会话管理和工具调用框架
- **`@mariozechner/pi-agent-core`** — 提供基础类型定义（如 `AgentMessage`）

不是 LangChain、Vercel AI SDK 之类的通用库。自己封装了流式模型调用、会话/transcript 管理、工具定义和执行、多 provider 支持（Anthropic、Google、Ollama 等）。

## 5. AI 如何使用 Skills

Skills 通过**两阶段 prompt 注入**机制工作：

### 加载阶段（agentCommand 中）

`buildWorkspaceSkillSnapshot` 从 workspace 目录扫描所有 skill 文件（SKILL.md），由 `@mariozechner/pi-coding-agent` 的 `loadSkillsFromDir` 解析，产出 `Skill` 对象（name、description、location）。

### 格式化阶段（resolveWorkspaceSkillPromptState 中）

- 过滤不符合条件的 skills（平台不匹配、缺少依赖、被 `disableModelInvocation` 标记的等）
- 应用数量和字符限制（默认最多 150 个 skill，最多 30000 字符）
- 调用 `formatSkillsForPrompt` 格式化成 XML：

```xml
<available_skills>
  <skill>
    <name>demo</name>
    <description>...</description>
    <location>/path/to/SKILL.md</location>
  </skill>
</available_skills>
```

### 注入阶段（buildAgentSystemPrompt → buildSkillsSection 中）

Skills 写入 system prompt 的 `## Skills (mandatory)` 段落，指令告诉 AI：

- 每次回复前扫描 `<available_skills>` 的 `<description>`
- 如果有一个 skill 明确适用，用 Read 工具读取它的 SKILL.md，然后按指引执行
- 如果多个适用，选最具体的那个
- 不要一次读多个 skill

### 运行时

AI 模型看到 system prompt 中的 skills 列表后，自主决定是否需要某个 skill。如果需要，用文件读取工具（Read tool）读取对应 SKILL.md 获取详细指令，然后按指令操作。

先给 AI 一个摘要目录（name + description），AI 按需再读取完整内容，既节省 context window 又保持灵活性。Skills 还可以通过 `command-dispatch: tool` 前置声明注册为用户可触发的 `/command`，但 AI 侧的使用始终是通过 prompt 驱动的。

## 6. AI 如何读取 Skill 的完整内容

AI 读取 skill 完整内容没有特殊的 skill 执行引擎，完全依赖标准的 tool use（function calling）机制。

### Skills 列表中的 location 字段

System prompt 中的 skills 列表包含每个 skill 的 `<location>` 字段，指向 SKILL.md 的文件路径：

```xml
<available_skills>
  <skill>
    <name>1password</name>
    <description>Manage 1Password vaults and items</description>
    <location>/Users/xxx/.openclaw/workspace/skills/1password/SKILL.md</location>
  </skill>
</available_skills>
```

### System prompt 中的指令

`buildSkillsSection`（`src/agents/system-prompt.ts`）在 system prompt 中写入明确指令：

```
## Skills (mandatory)
Before replying: scan <available_skills> <description> entries.
- If exactly one skill clearly applies: read its SKILL.md at <location> with `read`, then follow it.
- If multiple could apply: choose the most specific one, then read/follow it.
- If none clearly apply: do not read any SKILL.md.
Constraints: never read more than one skill up front; only read after selecting.
```

### Read 工具

AI 决定使用某个 skill 时，发起一次 tool call，调用 `read` 工具，传入 `<location>` 中的路径。

这个 `read` 工具来自 `@mariozechner/pi-coding-agent` 的 `createReadTool`，被 OpenClaw 包装了一层（`createOpenClawReadTool`，在 `src/agents/pi-tools.read.ts`），加了自适应分页、图片处理等能力，但本质就是读文件内容返回给 AI。

工具注册在 `createOpenClawCodingTools`（`src/agents/pi-tools.ts`）中，和 `exec`、`write`、`edit` 等工具一起作为 AI agent 的可用工具集。

### 完整流程

1. AI 收到用户消息
2. 扫描 system prompt 中的 `<available_skills>` 摘要目录
3. 判断是否有 skill 适用
4. 如果适用，通过 function calling 调用 `read` 工具读取对应 SKILL.md 的完整内容
5. 拿到完整内容后，按 SKILL.md 中的指引执行后续操作

没有特殊的 skill 执行引擎，整个 skill 系统完全建立在 AI 的 tool use 能力之上。

## 7. LLM 如何"自己选择调用 read 工具"

这不是 OpenClaw 代码实现的决策逻辑，而是 LLM 的 function calling / tool use 协议在起作用。

### Agent Loop 的核心流程（runEmbeddedAttempt）

在 `src/agents/pi-embedded-runner/run/attempt.ts` 的 `runEmbeddedAttempt` 中：

1. 注册工具：

```typescript
const toolsRaw = createOpenClawCodingTools({ ... });
// 包含 read、write、edit、exec 等工具
```

2. 创建 agent session，把工具传进去：

```typescript
({ session } = await createAgentSession({
  tools: builtInTools,
  customTools: allCustomTools,
}));
```

3. 发送 prompt 给 LLM：

```typescript
await activeSession.prompt(effectivePrompt);
```

### prompt() 内部的 Agent Loop

`activeSession.prompt()` 内部（由 `@mariozechner/pi-coding-agent` 实现）做的事情是：

1. 把 system prompt（包含 skills 列表）+ 用户消息 + 工具定义（JSON Schema 格式）一起发给 LLM API
2. LLM 返回的响应可能是普通文本，也可能是一个 tool_use 请求（比如 `{ tool: "read", params: { path: "/path/to/SKILL.md" } }`）
3. agent loop 检测到 tool_use 响应后，自动执行对应的工具函数，把结果作为 tool_result 再发回给 LLM
4. LLM 看到 tool_result 后继续推理，可能再调用其他工具，或者输出最终回复
5. 这个循环一直持续到 LLM 不再请求 tool_use 为止

### 职责划分

LLM 厂商负责的（Anthropic tool use / OpenAI function calling / Google tool use）：

- 根据 system prompt 中的 skills 列表和用户消息，自主决定是否需要调用工具
- 生成 tool_use 请求（指定工具名和参数）

OpenClaw 代码负责的：

- 定义有哪些工具可用（`createOpenClawCodingTools`，在 `src/agents/pi-tools.ts`）
- 在 system prompt 里告诉 LLM 有哪些 skills 以及怎么用 read 去读
- 当 LLM 返回 tool_use 请求时，执行对应工具并返回结果（`pi-coding-agent` 的 agent loop 自动处理）

`pi-coding-agent` 的 agent loop 负责的：

- 管理 LLM 调用 → tool_use → 执行工具 → tool_result → 再次调用 LLM 的循环
- 会话历史管理（SessionManager）
- 流式响应处理（通过 `streamSimple` 调用 `pi-ai`）

所以"AI 自己选择调用 read 工具"是 LLM 原生的 function calling 能力，OpenClaw 只是提供了工具定义和执行环境，以及通过 prompt 引导 LLM 在合适的时机使用 read 工具去读取 SKILL.md。
