# OpenClaw-Tool Implementation Roadmap

## 总体愿景 (The North Star)

将 Agent 的工具交互模式从“死板的预先声明 (Static Function Calling)” 升级为“符合直觉的渐进式探索 (Dynamic CLI-Centric Discovery)”。通过构建 `openclaw-tool`，激活模型预训练中庞大的 Bash 生态潜意识，实现极高的 Token 效率与专注度。

**架构核心升级（Thin Client + RPC Daemon）：**
为了完美兼容 Bash 的复杂语法（管道 `|`、逻辑与或 `&&`、子命令 `$(...)` 等），我们放弃脆弱的“字符串拦截”，采用**瘦客户端 (Thin Client) 配合主进程通信 (RPC Daemon)** 的模式。这既保证了其作为一个真实可注册命令的存在，又绕过了新进程冷启动和权限断层的天坑。

---

## 阶段一：RPC 瘦客户端与守护进程架构 (Hours 0-12)

**目标：建立一个真实的 CLI 入口，并通过 IPC/Socket 与 OpenClaw 主进程无缝通信，实现状态继承与零冷启动。**

### 1. 环境注入与上下文透传 (Context Injection)

- **定位：** `src/auto-reply/reply/bash-command.ts` (或 `src/agents/bash-tools.exec.ts`)。
- **逻辑：**
  - 在 Agent 启动真实的 `bash` 进程前，在环境变量中静默注入上下文。
  - 注入变量示例：`OPENCLAW_INTERNAL_SESSION=<session_key>`, `OPENCLAW_RPC_PORT=<port_or_socket>`。
  - 确保 Agent 执行的任何命令都能继承这些隐式身份凭证。

### 2. 轻量级可执行文件 (The Thin Client)

- **定位：** 注入到 Agent 的沙盒 `PATH` 中，或者作为一个独立的极简 Node 脚本（如 `bin/openclaw-tool-client.mjs`）。
- **逻辑：**
  - **极速启动：** 不加载任何大体量的库。
  - **单纯转发：** 捕获 `process.argv`（解析好的参数）和 `process.stdin`（管道输入），带上环境变量中的 `SESSION`，通过 HTTP/Socket/IPC 发送给主进程。
  - **输出呈现：** 接收主进程返回的 `stdout/stderr` 并原样打印。

### 3. 主进程 RPC 守护与注册表 (RPC Daemon & Tool Registry)

- **定位：** 新建 `src/agents/cli-runner/rpc-daemon.ts` 及 `registry.ts`。
- **逻辑：**
  - 在 OpenClaw 主循环启动时，挂载一个内部通信的微型 Server。
  - 接收到瘦客户端的请求后，校验 `SESSION`，并根据命令路由到内部真实的 `AnyAgentTool` 执行函数（如 `agents_list`, `feishu_update`）。
  - **维持可注册性：** 提供标准化的接口，允许现有工具和未来的 MCP 插件注册为这个 RPC Daemon 下的子命令。

---

## 阶段二：动态 Help 系统与上下文接管 (Hours 12-24)

**目标：实现“实验特性 1”，彻底改变 `--help` 的输出行为，将其从 stdout 提升为系统级的 Schema 上下文。**

### 1. RPC 层的 `--help` 拦截与生成

- **逻辑：** 当主进程的 RPC Daemon 解析到请求包含 `--help` 或 `-h` 时，跳过业务函数的执行。
- **生成指南：** 动态读取该工具原本的 JSON Schema，反向生成标准的、人类友好的 Bash `--help` 文本。

### 2. 跨层上下文重定向机制 (Context Redirection)

- **挑战：** 传统命令将帮助信息直接打印。我们需要将其截获并修补到模型的认知里。
- **天然优势：** 由于我们现在的处理逻辑在**主进程**中（RPC Daemon），我们可以直接触及 Agent 的运行上下文。
- **机制：** 主进程生成 `--help` 文本后，不仅通过 RPC 将简短提示返回给瘦客户端（例如：“Schema 已在后台为您更新”），**同时在内存中直接触发当前 Session 的 Schema/System Prompt 更新事件**。

---

## 阶段三：模型认知与 Prompt 重构 (Hours 24-36)

**目标：让 Agent 知道并且习惯使用 `openclaw-tool`，停止向它灌输冗长的传统工具定义。**

### 1. 精简 Tool Catalog

- **定位：** `src/agents/tool-catalog.ts`。
- **逻辑：**
  - 增加一个“CLI Mode”开关。开启时，不再将具体的业务工具（如 `agents_list`, `feishu_update`）压入传递给 LLM 的 `tools` 数组。
  - 仅保留底层的 `bash` 工具和文件操作系统。

### 2. 注入“塞尔达引导” (Zelda Prompting)

- **定位：** System Prompt 生成处。
- **逻辑：** 在系统提示词中增加认知引导：
  > "You operate in a highly streamlined shell environment. You have a universal command-line utility: `openclaw-tool`. Treat it like `git` or `docker`. Do not look for separate function calls; use `bash` to run `openclaw-tool --help` to intuitively discover and execute actions within your current context."

---

## 阶段四：验证与生态兼容映射 (Hours 36-48)

**目标：跑通全链路，并证明该架构对复杂 Bash 语法和外部插件/MCP 的兼容性。**

### 1. 跑通 Golden Path (包含复杂语法)

- **验证流程：**
  1. Agent 运行 `openclaw-tool --help`。系统后台更新 Schema，前端提示更新成功。
  2. Agent 运行带管道的复杂命令：`cat data.json | openclaw-tool feishu update --id 123`。
  3. 瘦客户端将 `stdin` 和参数通过 RPC 传给主进程，主进程的 `feishu_update` 函数成功接收到数据并执行，结果返回前端。

### 2. MCP 与插件的通用映射 (Generic Mapping)

- **逻辑设计：**
  - 探索如何将动态加载的 MCP 工具自动装载到 `openclaw-tool <plugin-name>` 子命令下。
  - **原则：** 一切新插件，不需要写新的适配代码，只要它符合 JSON Schema，RPC Daemon 就能自动将其转化为 CLI 参数（如把 JSON 属性映射为 `--<property-name>`）。

---

## 阶段五（远期）：智能与动态化 (Future & Experimental)

**目标：实现自适应的工具呈现，彻底消除长尾 Token 消耗。**

### 1. 频次缓存 (LFU/LRU Command Cache)

- 记录模型调用最频繁的 `openclaw-tool` 子命令。
- 在后续对话中，自动在 Schema 中附带这些高频命令的简要说明，省去模型每次查询 `--help` 的步骤。

### 2. 语义嵌入匹配 (Semantic Schema Injection)

- 引入本地轻量级 Embedding 模型或 TF-IDF 匹配。
- 当模型在思维链 (thinking) 中表达“需要更新文档”时，系统在后台比对意图，自动将 `openclaw-tool feishu update` 的帮助信息“闪现”到下一个 Turn 的上下文中。
