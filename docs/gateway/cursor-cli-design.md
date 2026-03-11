# Cursor CLI 后端 -- 设计文档

## 概述

将 Cursor headless CLI（`agent` 命令）作为内置 CLI 后端集成到 OpenClaw，
与现有的 `claude-cli`、`codex-cli` 并列，使用户可通过 `cursor-cli/<model>` 模型引用
调用 Cursor 的 AI 能力。

## 设计动机

OpenClaw 已有 CLI 后端机制，支持将外部 AI CLI 作为文本回退通道。Cursor 于 2026 年初
推出了 headless CLI（命令名 `agent`），提供非交互模式、JSON 输出、模型选择、会话恢复
等完整能力。将其纳入内置后端可以：

- 复用用户已有的 Cursor 订阅，无需额外 API Key
- 利用 Cursor 聚合的多模型能力（Claude、GPT、Gemini 等）
- 零配置即用，与 `claude-cli` / `codex-cli` 体验一致

## 架构位置

```
用户消息 (飞书/Telegram/WhatsApp/...)
    │
    ▼
OpenClaw Gateway
    │
    ├─ API Provider (anthropic, openai, ...)    ← 直接调用模型 API
    ├─ CLI Backend: claude-cli                  ← 调用 Claude Code CLI
    ├─ CLI Backend: codex-cli                   ← 调用 OpenAI Codex CLI
    ├─ CLI Backend: cursor-cli  [新增]          ← 调用 Cursor headless CLI
    └─ ACP (Agent Client Protocol)              ← 通过 ACP 协议调用外部 Agent
```

CLI 后端执行链路：

```
resolveCliBackendConfig("cursor-cli")
    → DEFAULT_CURSOR_BACKEND (合并用户 override)
    → buildCliArgs()  构建命令行参数
    → ProcessSupervisor.spawn()  执行 `agent -p --output-format json --force ...`
    → parseCliJson()  解析 JSON 输出，提取 result + session_id
    → 返回 CliOutput { text, sessionId }
```

## Cursor CLI 接口分析

参考文档：[Cursor CLI Headless](https://cursor.com/docs/cli/headless)

### 关键命令参数

| 参数                   | 说明                         |
| ---------------------- | ---------------------------- |
| `-p, --print`          | 非交互模式，输出到 stdout    |
| `--output-format json` | 单次 JSON 输出（完成后输出） |
| `--force`              | 允许直接修改文件，无需确认   |
| `--model <model>`      | 指定模型                     |
| `--resume [chatId]`    | 恢复已有会话                 |
| `--workspace <dir>`    | 指定工作目录                 |

### JSON 输出格式

```json
{
  "type": "result",
  "subtype": "success",
  "is_error": false,
  "duration_ms": 1234,
  "duration_api_ms": 1234,
  "result": "<完整助手文本>",
  "session_id": "<uuid>",
  "request_id": "<可选>"
}
```

### 与现有解析器的兼容性

OpenClaw 的 `parseCliJson()` 按以下顺序提取文本：

```typescript
const text =
  collectText(parsed.message) || // Claude Code CLI
  collectText(parsed.content) || // 通用
  collectText(parsed.result) || // ← Cursor 匹配此路径
  collectText(parsed);
```

`pickSessionId()` 默认查找字段列表包含 `session_id`，与 Cursor 输出完全匹配。

**结论：无需修改解析代码。**

## 代码变更详情

### 1. `src/agents/cli-backends.ts` -- 核心后端注册

**新增 `DEFAULT_CURSOR_BACKEND` 常量（第 110-126 行）：**

```typescript
const DEFAULT_CURSOR_BACKEND: CliBackendConfig = {
  command: "agent",
  args: ["-p", "--output-format", "json", "--force"],
  resumeArgs: ["-p", "--output-format", "json", "--force", "--resume", "{sessionId}"],
  output: "json",
  input: "arg",
  modelArg: "--model",
  sessionIdFields: ["session_id", "sessionId"],
  sessionMode: "existing",
  reliability: {
    watchdog: {
      fresh: { ...CLI_FRESH_WATCHDOG_DEFAULTS },
      resume: { ...CLI_RESUME_WATCHDOG_DEFAULTS },
    },
  },
  serialize: true,
};
```

配置说明：

| 字段          | 值                                             | 设计理由                          |
| ------------- | ---------------------------------------------- | --------------------------------- |
| `command`     | `"agent"`                                      | Cursor CLI 可执行文件名           |
| `args`        | `["-p", "--output-format", "json", "--force"]` | 非交互 + JSON 输出 + 允许文件修改 |
| `resumeArgs`  | 含 `--resume {sessionId}`                      | Cursor 使用 `--resume` 恢复会话   |
| `output`      | `"json"`                                       | 输出为单个 JSON 对象              |
| `modelArg`    | `"--model"`                                    | Cursor 标准模型参数               |
| `sessionMode` | `"existing"`                                   | 仅在有已存会话时传 session id     |
| `serialize`   | `true`                                         | 串行化运行，避免并发冲突          |

注意事项：

- **不设置 `systemPromptArg`**：Cursor CLI 不支持 `--append-system-prompt`
- **不设置 `sessionArg`**：会话恢复完全通过 `resumeArgs` 中的 `--resume` 实现
- **不设置 `clearEnv`**：无需清理与其他提供商冲突的环境变量

**修改 `resolveCliBackendIds()`（第 223-233 行）：**

在内置 ID 集合中添加 `"cursor-cli"`：

```typescript
export function resolveCliBackendIds(cfg?: OpenClawConfig): Set<string> {
  const ids = new Set<string>([
    normalizeBackendKey("claude-cli"),
    normalizeBackendKey("codex-cli"),
    normalizeBackendKey("cursor-cli"), // ← 新增
  ]);
  // ...
}
```

**修改 `resolveCliBackendConfig()`（第 261-268 行）：**

添加 `cursor-cli` 分支，复用 `mergeBackendConfig` 支持用户 override：

```typescript
if (normalized === "cursor-cli") {
  const merged = mergeBackendConfig(DEFAULT_CURSOR_BACKEND, override);
  const command = merged.command?.trim();
  if (!command) {
    return null;
  }
  return { id: normalized, config: { ...merged, command } };
}
```

### 2. `src/agents/model-selection.ts` -- CLI Provider 识别

**修改 `isCliProvider()` 函数（第 112-114 行）：**

添加 `cursor-cli` 的硬编码检测，使其无需用户在 `cliBackends` 配置中显式声明
即可被识别为 CLI 提供商：

```typescript
if (normalized === "cursor-cli") {
  return true;
}
```

此检测影响：模型选择路径会根据 `isCliProvider()` 的返回值决定走 CLI runner
而非 embedded Pi runner。

### 3. `src/secrets/provider-env-vars.ts` -- 环境变量映射

**新增一行（第 26 行）：**

```typescript
"cursor-cli": ["CURSOR_API_KEY"],
```

使 OpenClaw 的凭证自动发现机制能识别 `CURSOR_API_KEY` 环境变量，
在 `listKnownSecretEnvVarNames()` 中将其纳入已知密钥列表。

### 4. `docs/gateway/cli-backends.md` -- 用户文档

**快速开始部分**新增 Cursor CLI 示例和认证说明。

**内置默认部分**新增 `cursor-cli` 的默认配置说明，包括：

- 命令：`agent`
- 参数：`-p --output-format json --force`
- 恢复参数：`--resume {sessionId}`
- 认证：`CURSOR_API_KEY` 或 `agent login`

### 5. `src/agents/cli-backends.test.ts` -- 单元测试

新增 `describe("resolveCliBackendConfig cursor-cli defaults")` 测试套件，包含 3 个测试用例：

| 测试用例                                                 | 验证内容                                                                 |
| -------------------------------------------------------- | ------------------------------------------------------------------------ |
| `is included in built-in backend ids`                    | `resolveCliBackendIds()` 返回集合包含 `cursor-cli`                       |
| `uses headless agent defaults for fresh and resume args` | 默认配置的 command、args、resumeArgs、output、modelArg、sessionMode 正确 |
| `retains defaults when only command is overridden`       | 用户仅覆盖 command 路径时其余默认值保留                                  |

### 6. `docs/gateway/cursor-cli-guide.md` -- 操作指南

新增独立的操作指南文档，覆盖安装、认证、配置、故障排查完整流程。

## 三方对比：内置 CLI 后端

| 维度     | claude-cli                            | codex-cli                   | cursor-cli                       |
| -------- | ------------------------------------- | --------------------------- | -------------------------------- |
| 命令     | `claude`                              | `codex`                     | `agent`                          |
| 输出格式 | json                                  | jsonl                       | json                             |
| 恢复输出 | json                                  | text                        | json                             |
| 权限控制 | `--permission-mode bypassPermissions` | `--sandbox workspace-write` | `--force`                        |
| 会话模式 | always（总是传 session id）           | existing（有才传）          | existing（有才传）               |
| 系统提示 | 支持（`--append-system-prompt`）      | 不支持                      | 不支持                           |
| 会话恢复 | `--resume {sessionId}`                | `exec resume {sessionId}`   | `--resume {sessionId}`           |
| 认证     | Keychain / credentials.json           | auth.json                   | `CURSOR_API_KEY` / `agent login` |
| 序列化   | 是                                    | 是                          | 是                               |

## 未修改的代码（兼容性验证）

以下模块无需修改，已验证兼容性：

- **`src/agents/cli-runner/helpers.ts`** -- `parseCliJson()` 的 `collectText(parsed.result)`
  匹配 Cursor 的 `result` 字段；`pickSessionId()` 匹配 `session_id` 字段
- **`src/agents/cli-runner.ts`** -- `runCliAgent()` 通过 `resolveCliBackendConfig` 获取
  配置后走通用流程，无 provider 特定逻辑
- **`src/config/types.agent-defaults.ts`** -- `CliBackendConfig` 类型定义已覆盖所有
  cursor-cli 需要的字段
- **`src/process/supervisor/`** -- 进程管理通用，无需适配

## 验证结果

- `pnpm build` -- 编译通过，无 TypeScript 错误，无 `[INEFFECTIVE_DYNAMIC_IMPORT]` 警告
- `pnpm test -- --run src/agents/cli-backends.test.ts` -- 9/9 测试通过（含 3 个新增）
- `pnpm test -- --run src/agents/cli-runner.test.ts` -- 7/7 测试通过
- `pnpm test -- --run src/agents/model-selection.test.ts` -- 全部通过
- Lint 检查 -- 所有修改文件无 linter 错误
