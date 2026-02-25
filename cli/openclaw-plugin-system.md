# OpenClaw 插件系统能力文档

## 概述

OpenClaw 采用基于注册式的插件架构，插件通过 `register(api)` / `activate(api)` 入口函数注册各种能力。插件以 `openclaw.plugin.json` 清单文件声明元数据，运行时由 Jiti 编译器加载 `.ts`/`.js` 模块。

---

## 一、插件定义格式

### 对象定义（推荐）

```typescript
export default {
  id: "my-plugin",
  name: "My Plugin",
  description: "插件描述",
  version: "1.0.0",
  kind: "memory",                       // 可选，特殊种类如 "memory"
  configSchema: { /* JSON Schema */ },
  register(api: OpenClawPluginApi) {
    // 注册各种能力...
  }
}
```

### 函数导出

```typescript
export default function(api: OpenClawPluginApi) {
  // 直接注册
}
```

### 清单文件 `openclaw.plugin.json`

```json
{
  "id": "my-plugin",
  "kind": "memory",
  "configSchema": { "type": "object" },
  "uiHints": { "embedding.apiKey": { "label": "API Key", "sensitive": true } }
}
```

---

## 二、插件 API（11 种核心能力）

| API 方法 | 功能 | 说明 |
|----------|------|------|
| `api.registerTool(tool, opts?)` | 注册 Agent 工具 | 让 LLM 可调用自定义工具，支持静态定义或按上下文动态工厂 |
| `api.on(hookName, handler, opts?)` | 注册生命周期 Hook | 23 种系统事件，支持优先级排序 |
| `api.registerHttpHandler(handler)` | 注册 HTTP 拦截器 | 拦截网关 HTTP 请求，返回 boolean 表示是否已处理 |
| `api.registerHttpRoute({ path, handler })` | 注册 HTTP 路由 | 注册专用端点（如 webhook 回调），路径唯一 |
| `api.registerChannel(registration)` | 注册消息通道 | 接入新的消息平台，需实现 ChannelPlugin 接口 |
| `api.registerGatewayMethod(method, handler)` | 注册网关方法 | 扩展 WebSocket 网关协议，不能覆盖核心方法 |
| `api.registerCli(registrar, opts?)` | 注册 CLI 子命令 | 添加自定义命令行子命令（Commander.js） |
| `api.registerService(service)` | 注册后台服务 | 长驻服务，有 start/stop 生命周期 |
| `api.registerProvider(provider)` | 注册 LLM Provider | 注册模型认证提供商（OAuth/API Key 等） |
| `api.registerCommand(command)` | 注册斜杠命令 | `/xxx` 命令，绕过 LLM 直接处理，不能覆盖内置命令 |
| `api.runtime` | 访问运行时 API | 配置读写、媒体处理、TTS、渠道发送、会话管理等 |

### 插件上下文属性

- `api.id / name / version / description / source` — 插件元数据
- `api.config` — 当前 OpenClawConfig
- `api.pluginConfig` — 插件自身配置（经过 schema 验证）
- `api.runtime: PluginRuntime` — 系统运行时 API
- `api.logger` — 分级日志（debug/info/warn/error）

---

## 三、Hook 系统（23 种事件）

### 执行模型

- **Void Hook**：所有 handler 并行执行（`Promise.all`），fire-and-forget
- **Modifying Hook**：按优先级串行执行，结果逐步合并，先设置的值优先保留
- **Sync Hook**：同步串行执行，不允许 async handler
- 所有 hook 默认 `catchErrors: true`，单个 handler 失败不影响其他

### 同步/异步调用方式

**绝大多数 Hook 都是异步（async/await）调用**，handler 可以返回 `Promise`，系统会等待结果。这意味着你可以在 handler 中调用后台 HTTP 接口、数据库等异步操作。

```typescript
// ✅ 异步 hook 中调用后台接口（完全支持）
api.on("before_tool_call", async (event) => {
  const resp = await fetch("https://your-backend.com/api/check", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tool: event.toolName, params: event.params }),
  });
  const result = await resp.json();
  if (result.blocked) {
    return { block: true, blockReason: result.reason };
  }
  if (result.modifiedParams) {
    return { params: result.modifiedParams };
  }
});
```

各 Hook 同步/异步分类：

| Hook | 异步？ | 执行方式 | 能否调后台接口 |
|------|--------|---------|--------------|
| `before_tool_call` | ✅ async | 顺序 await（按优先级） | ✅ |
| `after_tool_call` | ✅ async | 并行（Promise.all） | ✅ |
| `before_prompt_build` | ✅ async | 顺序 await | ✅ |
| `before_model_resolve` | ✅ async | 顺序 await | ✅ |
| `before_agent_start` | ✅ async | 顺序 await | ✅ |
| `message_sending` | ✅ async | 顺序 await | ✅ |
| `message_received` | ✅ async | 并行（Promise.all） | ✅ |
| `message_sent` | ✅ async | 并行（Promise.all） | ✅ |
| `llm_input` / `llm_output` | ✅ async | 并行（Promise.all） | ✅ |
| `agent_end` | ✅ async | 并行（Promise.all） | ✅ |
| `subagent_spawning` | ✅ async | 顺序 await | ✅ |
| `gateway_start` / `gateway_stop` | ✅ async | 并行（Promise.all） | ✅ |
| `tool_result_persist` | **❌ 同步** | 同步串行 | **❌ 返回 Promise 会被忽略并警告** |
| `before_message_write` | **❌ 同步** | 同步串行 | **❌ 返回 Promise 会被忽略并警告** |

> **注意**：`tool_result_persist` 和 `before_message_write` 是仅有的两个同步 Hook，如果 handler 返回 Promise，系统会忽略结果并打 warn 日志。其余所有 Hook 均支持 async handler。

### Agent 阶段

| Hook | 可修改 | 用途 |
|------|--------|------|
| `before_model_resolve` | ✅ | 覆盖 model/provider 选择 |
| `before_prompt_build` | ✅ | 注入 systemPrompt、前置上下文 |
| `before_agent_start` | ✅ | 合并以上两者（遗留兼容） |
| `llm_input` | ❌ | 观察发给 LLM 的完整输入 |
| `llm_output` | ❌ | 观察 LLM 输出（含 token 统计） |
| `agent_end` | ❌ | agent 运行结束后分析 |
| `before_reset` | ❌ | 会话重置前触发 |

### 压缩阶段

| Hook | 可修改 | 用途 |
|------|--------|------|
| `before_compaction` | ❌ | 上下文压缩前通知 |
| `after_compaction` | ❌ | 压缩完成后通知 |

### 消息阶段

| Hook | 可修改 | 用途 |
|------|--------|------|
| `message_received` | ❌ | 收到入站消息 |
| `message_sending` | ✅ | 修改/取消出站消息（可设 `cancel: true`） |
| `message_sent` | ❌ | 消息已发送 |

### 工具阶段

| Hook | 可修改 | 用途 |
|------|--------|------|
| `before_tool_call` | ✅ | 修改参数或阻止工具调用（`block: true`） |
| `after_tool_call` | ❌ | 工具调用完成后 |
| `tool_result_persist` | ✅ (同步) | 修改写入 transcript 的 toolResult 消息 |

### 消息写入阶段

| Hook | 可修改 | 用途 |
|------|--------|------|
| `before_message_write` | ✅ (同步) | 拦截/修改写入 JSONL 的消息，可 `block: true` 阻止写入 |

### Session 阶段

| Hook | 可修改 | 用途 |
|------|--------|------|
| `session_start` | ❌ | 新 session 开始 |
| `session_end` | ❌ | session 结束 |

### 子 Agent 阶段

| Hook | 可修改 | 用途 |
|------|--------|------|
| `subagent_spawning` | ✅ | 拦截/修改子 agent 创建 |
| `subagent_delivery_target` | ✅ | 解析子 agent 消息投递目标 |
| `subagent_spawned` | ❌ | 子 agent 已创建 |
| `subagent_ended` | ❌ | 子 agent 已结束 |

### 网关阶段

| Hook | 可修改 | 用途 |
|------|--------|------|
| `gateway_start` | ❌ | 网关服务启动 |
| `gateway_stop` | ❌ | 网关服务停止 |

---

## 四、拦截能力对比：用户输入 vs 工具调用

### 用户 prompt 输入 — 间接拦截

**不能直接修改用户输入原文**，但可以通过注入上下文和覆盖系统提示来间接影响 Agent 行为。

`before_prompt_build` 事件包含 `event.prompt`（用户输入原文）和 `event.messages`（会话历史），但返回值只支持：
- `systemPrompt` — 覆盖系统提示词
- `prependContext` — 在用户消息前注入额外上下文

```typescript
// ✅ 能做到：注入上下文影响 LLM 行为
api.on("before_prompt_build", (event) => {
  if (event.prompt.includes("敏感词")) {
    return {
      systemPrompt: "你必须拒绝回答任何涉及敏感话题的问题",
      prependContext: "[安全审查] 用户输入包含敏感内容，请谨慎回复"
    };
  }
});

// ❌ 做不到：直接篡改用户输入文本
// 没有 return { prompt: "替换后的文本" } 这种能力
```

### 工具调用 — 完全拦截

`before_tool_call` 是 Modifying Hook，支持修改参数和阻止执行：

```typescript
api.on("before_tool_call", (event) => {
  // 完全阻止
  return { block: true, blockReason: "不允许执行" };

  // 或修改参数
  return { params: { ...event.params, command: "echo 已拦截" } };
});
```

### 能力对比表

| 维度 | 用户 prompt | 工具调用 |
|------|------------|---------|
| **能否观察** | ✅ `message_received` + `before_prompt_build` | ✅ `before_tool_call` + `after_tool_call` |
| **能否修改** | ⚠️ 不能改原文，只能注入 systemPrompt / prependContext | ✅ 可修改 `params` |
| **能否阻止** | ⚠️ 不能阻止 Agent 运行，但可通过 `message_sending` 拦截回复 | ✅ `block: true` 直接阻止 |
| **拦截时机** | prompt 构建阶段 | 工具执行前 |

---

## 五、工具调用 Hook 详解

OpenClaw 中所有 Agent 能力（读文件、写文件、执行命令等）均统一建模为工具调用，通过 `before_tool_call` 拦截。

### 核心 Agent 工具名

| 工具名 | 功能 |
|--------|------|
| `Bash` | 执行 shell 命令（node、npm、git 等均通过此工具） |
| `Read` | 读取文件 |
| `Write` | 写入文件 |
| `Edit` / `MultiEdit` | 编辑文件 |
| `ListDir` | 列出目录 |

### 拦截示例

```typescript
// 拦截文件写入
api.on("before_tool_call", (event) => {
  if (event.toolName === "Write" || event.toolName === "Edit") {
    const filePath = event.params.file_path as string;
    if (filePath?.includes(".env")) {
      return { block: true, blockReason: "禁止修改敏感文件" };
    }
  }
});

// 拦截危险 shell 命令
api.on("before_tool_call", (event) => {
  if (event.toolName === "Bash") {
    const cmd = event.params.command as string;
    if (/rm\s+-rf\s+\//.test(cmd)) {
      return { block: true, blockReason: "禁止执行危险删除命令" };
    }
  }
});

// 审计所有工具调用
api.on("after_tool_call", (event) => {
  console.log(`[审计] ${event.toolName} (${event.durationMs}ms) ${event.error ?? "OK"}`);
});
```

---

## 六、PluginRuntime 运行时能力

通过 `api.runtime` 暴露的系统级 API：

| 模块 | 能力 |
|------|------|
| `runtime.config` | 配置读写（`loadConfig()`、`writeConfigFile()`） |
| `runtime.system` | 系统事件、命令执行、原生依赖提示 |
| `runtime.media` | 媒体加载、MIME 检测、图片处理、音频判断 |
| `runtime.tts` | TTS 语音合成 |
| `runtime.tools` | Memory 工具创建、Memory CLI 注册 |
| `runtime.channel` | 渠道相关能力（详见下方） |
| `runtime.logging` | 日志系统 |
| `runtime.state` | 状态目录解析 |

### runtime.channel 子模块

| 子模块 | 能力 |
|--------|------|
| `text` | 分块、Markdown 表格、控制命令检测 |
| `reply` | 回复分发、typing 回调、信封格式化 |
| `routing` | agent 路由解析 |
| `pairing` | 设备配对 |
| `media` | 远程媒体下载与存储 |
| `session` | 会话管理 |
| `mentions` | @提及检测 |
| `debounce` | 入站消息防抖 |
| 各平台 API | discord / slack / telegram / signal / imessage / whatsapp / line 等 |

---

## 七、Channel 插件接口

通过 `api.registerChannel()` 注册的消息渠道插件需实现 `ChannelPlugin` 接口：

| 适配器 | 必需 | 职责 |
|--------|------|------|
| `id` / `meta` / `capabilities` | ✅ | 标识与能力声明 |
| `config` | ✅ | 账户配置管理 |
| `configSchema` | ❌ | 配置 JSON Schema |
| `onboarding` | ❌ | CLI 安装向导 |
| `setup` / `pairing` | ❌ | 初始化与设备配对 |
| `security` | ❌ | DM 策略、安全检查 |
| `groups` / `mentions` | ❌ | 群组与 @提及处理 |
| `outbound` | ❌ | 消息发送 |
| `gateway` | ❌ | 连接生命周期（startAccount/stopAccount） |
| `auth` / `elevated` | ❌ | 身份认证 |
| `commands` / `streaming` / `threading` | ❌ | 命令、流式回复、线程管理 |
| `directory` / `resolver` | ❌ | 联系人目录与目标解析 |
| `actions` / `heartbeat` | ❌ | 消息动作、心跳 |
| `agentTools` | ❌ | 渠道专有 agent 工具 |

---

## 八、插件配置

在 `openclaw.yaml` 中配置：

```yaml
plugins:
  enabled: true                 # 全局开关
  allow: ["voice-call"]         # 白名单
  deny: ["some-bad-plugin"]     # 黑名单
  load:
    paths: ["./my-plugins"]     # 额外加载路径
  slots:
    memory: "memory-lancedb"    # 或 "none" 禁用
  entries:
    voice-call:
      enabled: true
      config:                   # 传给 api.pluginConfig
        provider: "twilio"
```

---

## 九、插件加载流程

1. **配置归一化** — 处理 enabled、allow/deny、loadPaths、slots、entries
2. **缓存检查** — 基于 workspace + 配置内容的 cache key
3. **发现阶段** — 按优先级从四个来源扫描：
   - `config paths`（`plugins.load.paths`）
   - `workspace`（`.openclaw/extensions/`）
   - `global`（`~/.config/openclaw/extensions/`）
   - `bundled`（内置插件）
4. **清单注册** — 解析所有 `openclaw.plugin.json`
5. **安全校验** — 路径逃逸检查、权限检查、文件所有者校验
6. **启用决策** — denylist > allowlist > entry config > bundled 默认 > 自动启用
7. **Memory Slot 决策** — `kind: "memory"` 插件只允许一个生效
8. **配置验证** — 用 JSON Schema 验证 pluginConfig
9. **模块加载** — 使用 Jiti 运行时编译器加载 `.ts`/`.js`
10. **注册执行** — 调用 `register(api)` / `activate(api)`
11. **全局 Hook Runner 初始化**

---

## 十、现有扩展插件（37 个）

### 消息通道（22 个）

Slack、Discord、Telegram、WhatsApp、Signal、iMessage、BlueBubbles、Microsoft Teams、Matrix、飞书、Google Chat、LINE、Zalo（Bot API）、Zalo User（个人账户）、Twitch、IRC、Mattermost、Nextcloud Talk、Nostr、Tlon

### 模型认证提供商（5 个）

Copilot Proxy、Google Antigravity Auth、Google Gemini CLI Auth、MiniMax Portal Auth、Qwen Portal Auth（通义千问）

### 记忆系统（2 个）

memory-core（基础实现）、memory-lancedb（LanceDB 向量记忆 + OpenAI Embeddings）

### 功能工具（6 个）

voice-call（语音电话）、lobster（工作流引擎）、llm-task（结构化 LLM 任务）、device-pair（设备配对）、phone-control（手机命令控制）、talk-voice（语音选择管理）

### 其他

diagnostics-otel（OpenTelemetry 诊断）、thread-ownership（Slack 线程所有权）、open-prose（OpenProse 多智能体编排）

---

## 十一、插件安装方式

### 1. 从 npm 安装（推荐）

```bash
openclaw plugins install <npm-package-spec>
```

支持标准 npm spec 格式（包名、`@scope/name`、`name@version` 等），自动下载、解压、安装依赖。可加 `--pin` 锁定精确版本。

### 2. 从本地目录安装（复制）

```bash
openclaw plugins install ./my-plugin/
```

将整个目录复制到 `~/.config/openclaw/extensions/` 下（Windows 为 `~/.openclaw/extensions/`），自动运行 `npm install --omit=dev` 安装依赖。

### 3. 从本地目录链接（不复制）

```bash
openclaw plugins install ./my-plugin/ --link
```

不复制文件，只把路径加入 `plugins.load.paths` 配置，开发迭代时很方便。

### 4. 从压缩包安装

```bash
openclaw plugins install ./plugin.tgz
openclaw plugins install ./plugin.zip
openclaw plugins install ./plugin.tar.gz
```

支持 `.tgz`、`.zip`、`.tar.gz`、`.tar` 格式，自动解压后按目录方式安装。

### 5. 从单文件安装

```bash
openclaw plugins install ./my-plugin.ts
openclaw plugins install ./my-plugin.js
```

直接复制单个 `.ts`/`.js` 文件到 extensions 目录。

### 自动发现来源（无需手动安装）

加载时按优先级从 4 个位置自动扫描：

| 优先级 | 来源 | 路径 | 说明 |
|--------|------|------|------|
| 1 | config paths | `plugins.load.paths` 配置项 | `--link` 安装的路径 |
| 2 | workspace | `.openclaw/extensions/` | 项目级插件 |
| 3 | global | `~/.openclaw/extensions/`（Windows）或 `~/.config/openclaw/extensions/` | 用户级插件 |
| 4 | bundled | 内置插件目录 | 随 OpenClaw 发行的插件 |

### 管理命令

| 命令 | 功能 |
|------|------|
| `openclaw plugins list` | 列出所有已发现的插件 |
| `openclaw plugins info <id>` | 查看插件详情 |
| `openclaw plugins enable <id>` | 启用插件 |
| `openclaw plugins disable <id>` | 禁用插件 |
| `openclaw plugins update [id] / --all` | 更新 npm 安装的插件 |
| `openclaw plugins uninstall <id>` | 卸载插件 |
| `openclaw plugins doctor` | 诊断插件加载问题 |

---

## 十二、安全机制

1. **路径安全** — 插件入口文件不允许逃逸其 rootDir
2. **权限检查** — 非 Windows 下检查 world-writable 和文件所有权
3. **命令注入防护** — 斜杠命令参数有长度限制（4096）和控制字符过滤
4. **命令保留** — 30+ 内置命令名不可被插件覆盖
5. **溯源警告** — 未被 install 记录追踪的插件会发出警告
6. **配置 Schema 强制** — 清单中须包含 configSchema
7. **注册表锁定** — 命令执行期间锁定注册表防止并发修改

---

## 十三、OneClaw（改版）插件安装指南

OneClaw 是基于 OpenClaw 的 Electron 桌面改版应用，内部嵌入 `openclaw` npm 包作为网关。

### 关键信息

- **安装路径**：`C:\Users\<用户名>\AppData\Local\Programs\OneClaw\`
- **内嵌 Node.js**：`resources\resources\runtime\node.exe`
- **内嵌 OpenClaw CLI**：`resources\resources\gateway\node_modules\openclaw\openclaw.mjs`
- **配置目录**：复用 `~/.openclaw/`（没有独立的 `~/.oneclaw/`）
- **插件目录**：`~/.openclaw/extensions/`
- **CLI 命令名**：仍然是 `openclaw`（底层是 openclaw 包）
- **内置额外插件**：`kimi-claw`（Kimi 模型接入）、`kimi-search`（Kimi 搜索）

### 完整命令格式

OneClaw 没有全局 CLI 命令（不在 PATH 中），需要用完整路径调用：

```powershell
& "C:\Users\leotwang\AppData\Local\Programs\OneClaw\resources\resources\runtime\node.exe" `
  "C:\Users\leotwang\AppData\Local\Programs\OneClaw\resources\resources\gateway\node_modules\openclaw\openclaw.mjs" `
  plugins install <插件>
```

### 推荐：设置 PowerShell 别名

在 PowerShell Profile 中添加以下函数后，即可像正常 CLI 一样使用：

```powershell
function oneclaw {
  & "C:\Users\leotwang\AppData\Local\Programs\OneClaw\resources\resources\runtime\node.exe" `
    "C:\Users\leotwang\AppData\Local\Programs\OneClaw\resources\resources\gateway\node_modules\openclaw\openclaw.mjs" @args
}
```

之后可以直接使用：

```powershell
# 安装插件
oneclaw plugins install <npm-package>
oneclaw plugins install ./my-plugin/
oneclaw plugins install ./plugin.tgz
oneclaw plugins install ./my-plugin/ --link

# 管理插件
oneclaw plugins list
oneclaw plugins info <id>
oneclaw plugins enable <id>
oneclaw plugins disable <id>
oneclaw plugins update --all
oneclaw plugins uninstall <id>
oneclaw plugins doctor

# 其他常用命令
oneclaw --version
oneclaw config list
```
