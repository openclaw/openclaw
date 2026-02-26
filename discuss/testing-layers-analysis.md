# OpenClaw 自动化测试分层分析

基于代码库调查（2026-02-26），覆盖 vitest 配置、CI 流水线、测试文件分布和实际测试代码。

---

## 总览

OpenClaw 有 **1,337 个测试文件**，分为六个层次，官方文档的描述是："Think of the suites as increasing realism (and increasing flakiness/cost)" -- 从上到下，真实度递增，稳定性和速度递减。

| 层           | 测试对象               | 文件数 | 外部依赖  | 速度   | CI 中运行 |
| ------------ | ---------------------- | ------ | --------- | ------ | --------- |
| Unit         | 纯函数/类              | ~987   | 无        | 毫秒级 | 是        |
| Gateway Unit | gateway 内部模块       | 83     | 无        | 毫秒级 | 是        |
| Extension    | 插件业务逻辑           | 121    | 无        | 毫秒级 | 是        |
| E2E          | 完整 gateway + WS 管线 | 340    | Mock HTTP | 秒级   | 是        |
| Live         | 真实 LLM provider API  | 10     | 真实网络  | 分钟级 | 否        |
| Docker E2E   | 完整安装+构建+使用流程 | 5 脚本 | Docker    | 分钟级 | 仅 smoke  |

---

## 第一层：纯单元测试 (Unit Tests)

- **运行命令**: `pnpm test`（内部分组为 `unit-fast` + `unit-isolated`）
- **配置**: `vitest.unit.config.ts`
- **匹配文件**: `src/**/*.test.ts`（排除 `gateway/`、`extensions/`、`*.e2e.test.ts`、`*.live.test.ts`）

### 做什么

测试单个函数或单个类的纯逻辑行为，完全不涉及网络、文件系统、外部服务。

### 典型例子

`src/infra/retry.test.ts`（测试 `retryAsync` 重试函数）：

- 用 `vi.fn().mockResolvedValue()` / `.mockRejectedValue()` 模拟被调用的 async 函数
- 用 `vi.useFakeTimers()` + `vi.runAllTimersAsync()` 控制时间流逝，测试延迟、退避、抖动
- 断言全是 `expect(...).toBe()` / `.rejects.toThrow()`
- 零 I/O，零副作用，毫秒级完成

### 隔离机制

- 全局 `test/setup.ts` 在每个 worker 进程中创建临时 HOME 目录 (`fs.mkdtempSync`)
- 清除所有真实的 API key 环境变量（`TELEGRAM_BOT_TOKEN`、`DISCORD_BOT_TOKEN` 等）
- `beforeEach` 注入 stub 的 channel 插件注册表（Discord/Slack/Telegram/WhatsApp/Signal/iMessage 全是空壳）
- `afterEach` 自动恢复被遗忘的 `vi.useFakeTimers()`

### 执行策略

- `vmForks` 池（Node 22/23），比 `forks` 更快，共享 V8 编译缓存
- 约 20 个"重量级"文件被拆分到 `unit-isolated` 组，用 `forks` 池串行跑（避免 vmForks 下环境泄漏）
- 重量级文件列表维护在 `scripts/test-parallel.mjs` 的 `unitIsolatedFilesRaw` 数组中

---

## 第二层：Gateway 单元测试

- **运行命令**: `pnpm test`（内部分组为 `gateway`）
- **配置**: `vitest.gateway.config.ts`
- **匹配文件**: `src/gateway/**/*.test.ts`

### 做什么

测试 gateway 进程内部的业务逻辑模块：认证限流器、路由解析、协议解析、session 管理等。不启动真正的 HTTP/WebSocket server。

### 典型例子

`src/gateway/auth-rate-limit.test.ts`（测试认证限流器）：

- 14 个测试覆盖：滑动窗口、锁定过期、per-IP 隔离、per-scope 隔离、loopback 豁免（IPv4/IPv6）、reset、pruning
- 用 `vi.useFakeTimers()` + `vi.advanceTimersByTime()` 模拟时间流逝
- 每个测试用工厂函数 `createAuthRateLimiter({...})` 创建新实例，`afterEach` 调用 `.dispose()` 清理内部 interval

### 为什么单独分组

Gateway 模块对全局状态和环境变量更敏感，强制使用 `forks` 池（非 `vmForks`）以确保确定性。CI 中默认串行执行，本地开发可通过 `OPENCLAW_TEST_PARALLEL_GATEWAY=1` 开启并行。

---

## 第三层：Extension 测试

- **运行命令**: `pnpm test`（内部分组为 `extensions`）
- **配置**: `vitest.extensions.config.ts`
- **匹配文件**: `extensions/**/*.test.ts`

### 做什么

测试插件/扩展包内部的业务逻辑。每个 extension 是一个独立的 workspace package，有自己的 `package.json`。

### 典型例子

`extensions/msteams/src/policy.test.ts`（MS Teams 策略逻辑）：

- 测试路由配置解析、回复策略解析、群组权限判断
- 全是纯函数测试：传入配置对象，检查返回值
- 通过 `openclaw/plugin-sdk` 导入核心类型定义（运行时通过 jiti alias 解析）
- 无 mock，无 server，无文件系统

### 覆盖范围

`msteams`、`matrix`、`zalo`、`zalouser`、`voice-call`、`nostr` 等扩展包，共 121 个测试文件。Extension 测试与 unit 测试结构一致，区别在于它们验证了 plugin SDK 的边界契约。

---

## 第四层：E2E 测试 (End-to-End, 进程内)

- **运行命令**: `pnpm test:e2e`
- **配置**: `vitest.e2e.config.ts`
- **匹配文件**: `src/**/*.e2e.test.ts`

### 做什么

在同一进程中启动**真正的 Gateway HTTP+WebSocket 服务器**，连接真正的 WebSocket 客户端，走完整的请求/响应链路。LLM 后端用 mock 替代，不需要真实 API key。

### 典型例子

`src/gateway/gateway.e2e.test.ts` 包含两个场景：

**场景 1 -- Mock OpenAI tool-call 闭环**：

1. 启动真实 gateway server（ephemeral port）
2. `installOpenAiResponsesMock()` 安装本地 HTTP mock 拦截 OpenAI API 请求
3. 连接 WebSocket 客户端
4. 发送 `agent` 请求，agent 调用 tool，tool 返回带 nonce 的结果
5. 断言最终回复包含预期的 nonce

**场景 2 -- Setup Wizard 流程**：

1. 启动 gateway，注入自定义 wizard runner
2. 通过 WebSocket 驱动交互式 wizard 协议（`wizard.start` -> `wizard.next` -> done）
3. 验证 config 文件被正确写入
4. 再启动第二个 server，验证写入的 auth token 能通过认证

### 隔离机制

- `fs.mkdtemp()` 创建隔离的临时 HOME 目录
- 保存/恢复所有相关环境变量（`HOME`、`OPENCLAW_GATEWAY_TOKEN`、`OPENCLAW_SKIP_CHANNELS` 等）
- 每个测试 timeout 90 秒
- 共享 helper 模块：`test-helpers.e2e.ts`、`test-helpers.openai-mock.ts`、`test-helpers.agent-results.ts`
- 自适应 worker 数：CI 2-4 个，本地 4-8 个

---

## 第五层：Live 测试 (Real Provider)

- **运行命令**: `pnpm test:live`（需要 `OPENCLAW_LIVE_TEST=1`）
- **配置**: `vitest.live.config.ts`
- **匹配文件**: `src/**/*.live.test.ts`
- **强制单 worker**: `maxWorkers: 1`（避免触发 provider rate limit）

### 做什么

调用**真实的 LLM provider API**（OpenAI、Anthropic、Google、MiniMax、Z.AI 等），验证"今天这个 provider/model 还能用吗"。

### 分为两个子层

**Layer 1: Direct Model Completion（不经过 gateway）**

- 文件: `src/agents/models.profiles.live.test.ts`
- 读取真实的 `~/.openclaw/credentials/` 配置
- 通过 `discoverModels()` 枚举可用模型
- 对每个有 key 的模型发一个小 prompt
- 目的：隔离"provider API 本身挂了"还是"我们的 gateway 管线挂了"

**Layer 2: Gateway + Agent Smoke（完整管线）**

- 文件: `src/gateway/gateway-models.profiles.live.test.ts`
- 启动真实 gateway server，对每个模型运行多个探针（probe）：
  - **基础聊天**: 发一个简单问题，检查返回是否有意义
  - **Read probe**: 写一个随机 nonce 文件，让 agent 用 `read` tool 读出来，验证 nonce 匹配
  - **Exec+Read probe**: 让 agent 用 `exec` tool 写 nonce 到文件，再 `read` 回来
  - **Image probe**: 生成一个包含随机代码的 PNG 图片，发给模型，验证 OCR 结果（`editDistance()` 模糊匹配）
  - **Reasoning tag leak 检测**: `assertNoReasoningTags()` 检查模型是否泄漏了内部推理标签

### 错误处理

专门的 helper 函数区分不同类型的 provider 错误：

- `isAnthropicBillingError` -- 账单问题
- `isAnthropicRateLimitError` -- 速率限制
- `isGoogleModelNotFoundText` -- 模型不存在
- `isRefreshTokenReused` -- OAuth token 问题

遇到这些错误时 skip 而非 fail，因为这是 provider 端的问题，不是代码 bug。

### 不在 CI 中运行

贵（消耗 API 额度）、慢（分钟级）、不稳定（依赖外部服务状态），只在开发者本地手动触发。

---

## 第六层：Docker E2E 测试

- **运行命令**: `pnpm test:docker:onboard`、`pnpm test:docker:gateway-network`、`pnpm test:docker:plugins` 等
- **脚本位置**: `scripts/e2e/*.sh`

### 做什么

在 Docker 容器中从零开始模拟用户的完整使用流程。这是唯一测试**构建产物**（`dist/`）而非 TypeScript 源码的层。

### onboard-docker.sh（新手引导流程）

1. `docker build`：Node 22 + pnpm install + pnpm build
2. 在容器内用 `script` + `mkfifo`（命名管道）模拟 TTY 交互输入
3. 向交互式 Clack wizard 发送按键序列（模拟用户选择）
4. 多个测试场景：`local-basic`（非交互）、`reset-config-only`、`channels-flow`、`skills-flow`
5. 验证生成的配置文件和目录结构（用 shell 断言 + 内联 Node.js 脚本解析 JSON）

### gateway-network-docker.sh（跨容器网络）

1. 创建 Docker network
2. 容器 A 启动 gateway，等待端口监听
3. 容器 B 连接 gateway，验证 WebSocket 连通性和健康检查
4. `trap cleanup EXIT` 清理容器和网络

### plugins-docker.sh（插件加载）

验证自定义 extension 在全新环境中能正确加载和注册。

### 独特之处

- 唯一的 Bash 脚本测试层
- 唯一使用 Docker 的层
- 能捕获打包/bundling 回归问题（in-process 测试发现不了）
- 最慢（Docker build + run），但最接近用户真实体验

---

## CI 流水线集成

CI 定义在 `.github/workflows/ci.yml`，有智能的变更检测来跳过无关的 job：

| CI Job                   | 触发条件           | 内容                                                                 |
| ------------------------ | ------------------ | -------------------------------------------------------------------- |
| `docs-scope`             | 每次               | 检测是否仅改了文档，是则跳过重型 job                                 |
| `changed-scope`          | 非纯文档变更       | 检测改了 Node/macOS/Android 哪个领域                                 |
| `check`                  | 非纯文档变更       | TypeScript 类型检查 (`pnpm tsgo`) + lint (`oxlint`) + 格式 (`oxfmt`) |
| `checks (node/test)`     | Node 相关变更      | `pnpm canvas:a2ui:bundle && pnpm test`（并行测试 runner）            |
| `checks (node/protocol)` | Node 相关变更      | `pnpm protocol:check`（协议 schema 校验）                            |
| `checks (bun/test)`      | 仅 PR              | `bunx vitest run --config vitest.unit.config.ts`（Bun 运行时兼容性） |
| `checks-windows`         | Node 相关变更      | 同上矩阵在 Windows 上重跑                                            |
| `secrets`                | 每次               | `detect-secrets` 扫描                                                |
| `macos`                  | macOS/iOS 相关变更 | TS 测试 + Swift lint/build/test                                      |
| `android`                | Android 相关变更   | Gradle 单元测试 + build                                              |
| `check-docs`             | 文档变更           | Markdown 格式/lint/链接检查                                          |
| `release-check`          | push 到 main       | 验证 npm pack 内容                                                   |

### 质量门禁

- **Pre-commit hook** (`git-hooks/pre-commit`): 自动 `oxlint --fix` + `oxfmt --write`
- **Pre-push 建议**: `pnpm build && pnpm check && pnpm test`
- **Coverage 阈值**: 70% lines/functions/statements, 55% branches

---

## 问题与改进空间

### 覆盖率统计的盲区

覆盖率配置 (`vitest.config.ts`) 使用 `all: false`，只统计被测试 import 过的文件。大量模块被排除在覆盖率计算之外：

- CLI 命令层 (`src/cli/**`, `src/commands/**`)
- 所有 channel 实现 (`src/discord/**`, `src/telegram/**`, `src/slack/**`, `src/signal/**`, `src/imessage/**`)
- Gateway 集成面 (`src/gateway/**`, `src/agents/**`)
- 插件系统 (`src/plugins/**`)
- Provider 层 (`src/providers/**`)

这些恰好是用户最常接触到的部分，也是 bug 体感最强的地方。

### Live 测试覆盖薄

只有 10 个 live 测试文件，且不在 CI 中运行。Provider 交互中的 bug（格式变更、tool-calling quirks、auth 问题）很难在 CI 中被自动捕获，依赖开发者手动验证。

### 未实现的测试计划

`docs/help/testing.md` 中提到了"Agent reliability evals (skills)"的规划，目前仍缺失：

- **Decisioning**: agent 是否选对了 skill
- **Compliance**: agent 是否遵循了 SKILL.md 的步骤
- **Workflow contracts**: 多轮对话中 tool 调用顺序、session 历史、sandbox 边界

### 不是严格的 TDD

没有 TDD 制度文档或流程要求。更准确的描述是 **regression-driven testing** -- 发现 bug 后补测试，文档也明确指导："When you fix a provider/model issue discovered in live: Add a CI-safe regression if possible"。
