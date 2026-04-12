# Patch 12: Plugin-SDK 导出扩展、通道导入护栏测试、Mattermost 修复

## 为什么要改 (Why)

### 问题 1: Plugin-SDK 导出表面不足

飞书扩展需要 hook runner、会话转录、消息清洗等能力，但 `plugin-sdk/index.ts` 和 `plugin-sdk/feishu.ts` 未导出这些符号。扩展只能通过违反 import boundary 的方式（直接 import `src/**`）来使用核心功能，违背了"扩展只通过 plugin-sdk 跨包"的架构规则。

### 问题 2: 缺少通道导入护栏测试

repo 的 CLAUDE.md 和 AGENTS.md 定义了严格的 import boundary 规则（扩展不能 import 其他扩展的 `src/`、核心不能 import 扩展 `src/`、扩展不能 import `openclaw/plugin-sdk` 根路径等），但没有自动化测试来守护这些规则。违规只能在 code review 中人工发现，容易遗漏。

### 问题 3: Mattermost channel-plugin-api barrel 缺失

Mattermost 扩展的 `index.ts` 和 `setup-entry.ts` 直接指向 `./src/channel.js` 作为 plugin specifier，违反了"扩展的公共表面应通过 barrel 文件暴露"的约定。缺少 `channel-plugin-api.ts` barrel 导致插件加载器直接触及扩展内部实现。

### 问题 4: Draft-chunking 配置迁移和冲突遗留

Discord 和 Telegram 的 `draft-chunking.ts` 仍然读取旧配置路径 `draftChunk`，而不是新的 `streaming.preview.chunk` 嵌套结构。多个文件中还有合并冲突遗留的类型问题（`status.ts`、`tokens.ts`、`send.ts` 等）需要修复。

## 改了什么 (What Changed)

| 文件 | 关键修改 |
|------|----------|
| `src/plugin-sdk/index.ts` | 新增 ~50 个导出：session binding service 全套类型和函数、diagnostic events 全套事件类型、mime 工具、skill commands、log transport、utils 工具函数 |
| `src/plugin-sdk/feishu.ts` | 新增 11 个导出：`getGlobalHookRunner`、`getLiveSessionTranscriptEntries`、session store 操作、`stripEnvelopeFromMessage`、`resolveUserPath` |
| `src/plugin-sdk/channel-import-guardrails.test.ts` | **新文件** (502 行)：8 个测试用例守护 import boundary 规则 |
| `src/plugins/contracts/plugin-sdk-index.test.ts` | 更新 runtime exports 白名单，覆盖新增的 20 个运行时导出 |
| `extensions/mattermost/channel-plugin-api.ts` | **新文件**：Mattermost plugin barrel，re-export `mattermostPlugin` |
| `extensions/mattermost/index.ts` | plugin specifier 从 `./src/channel.js` 改为 `./channel-plugin-api.js` |
| `extensions/mattermost/setup-entry.ts` | plugin specifier 从 `./src/channel.js` 改为 `./channel-plugin-api.js` |
| `extensions/discord/src/draft-chunking.ts` | 配置读取迁移到 `streaming.preview.chunk`，保留 `draftChunk` legacy fallback |
| `extensions/telegram/src/draft-chunking.ts` | 同 Discord：迁移到新配置路径 + legacy fallback |
| `extensions/feishu/src/send.ts` | 新增 `sanitizeFeishuTextForDelivery`：发送前剥离内联指令标签 `[[reply_to_current]]` 等 |
| `extensions/feishu/src/send.test.ts` | 4 个新测试：send/edit/structured card/markdown card 的标签剥离 |
| `src/auto-reply/status.ts` | chunk-aware CLI prompt 状态行、last runtime model 显示、CLI provider 条件过滤 |
| `src/auto-reply/tokens.ts` | 新增 `isSilentReplyTailFragmentText`：识别 `_REPLY` 等 silent token 尾片段 |
| `src/auto-reply/reply/agent-runner-execution.ts` | silent token 尾片段跳过、纯空白 streaming delta 透传、followup 传递 skillsSnapshot |
| `src/agents/cli-runner/execute.ts` | EOF marker 替换为 `expectedTotalLines` 行号对比验证；`extractLastReadLineNumber` 正则提取 |
| `src/agents/cli-runner.test.ts` | 测试基础设施重构：`createClaudeStreamSuccess` 改为延迟求值（factory function），支持多 chunk 动态发现 |
| `extensions/diffs/src/language-hints.test.ts` | 类型断言修复 (`as Iterable<string>`, `as unknown as NonNullable<...>`) |
| `extensions/discord/src/draft-chunking.test.ts` | 配置结构更新到 `streaming.preview.chunk` |
| `extensions/telegram/src/bot-message-dispatch.test.ts` | `blockStreaming: true` 改为 `streaming: { block: { enabled: true } }` |
| `extensions/telegram/src/bot.helpers.test.ts` | draft chunking 配置结构更新 |
| `extensions/memory-core/src/memory/manager.async-search.test.ts` | 改为 `vi.resetModules()` + `vi.doMock` per-test 隔离 |
| `extensions/memory-wiki/src/gateway.ts` | 类型收窄：`GatewayRespond` 显式类型、`respondError` 加 `code` 字段、非空断言 |
| `extensions/memory-wiki/src/obsidian.test.ts` | exec mock 类型签名修复 |
| `extensions/msteams/src/sdk.ts` | 内联 `IHttpServerAdapter` 类型替代从 `@microsoft/teams.apps` 深度导入 |
| `extensions/google/test-api.ts` | 新增 `buildGoogleGeminiCliBackend` test export |
| `extensions/openai/test-api.ts` | 新增 `buildOpenAICodexCliBackend` test export |
| `src/auto-reply/reply/session.test.ts` | 补充 chunk metadata 字段到 cliPromptLoad 测试数据 |
| `src/auto-reply/status.test.ts` | chunk-aware status line 测试、last runtime model 测试 |
| `src/auto-reply/status.cli-prompt-load.test.ts` | chunk-aware prompt loader status 渲染测试 |
| `src/auto-reply/tokens.test.ts` | `isSilentReplyTailFragmentText` 测试用例 |
| `src/commands/doctor-legacy-config.migrations.test.ts` | streaming 配置结构更新 |
| `src/plugins/bundle-manifest.ts` | 移除 `JSON5.parse` 的 `as unknown` 冗余断言 |
| `src/plugin-sdk/test-helpers.ts` | 修复 `RmOptions` 的 import 方式（从 `node:fs` 而非 `node:fs/promises`） |
| `test/helpers/plugins/plugin-runtime-mock.ts` | 新增 `agents` 和 `hooks` mock 属性 |
| `.gitignore` | 添加 `skills/skillstore-plugin-publisher/` |

## 伪代码 (Pseudocode)

### 1. 通道导入护栏测试核心逻辑

```javascript
// channel-import-guardrails.test.ts

// 遍历所有扩展源文件
function collectExtensionSourceFiles() {
  const files = []
  const stack = [extensionsDir]
  while (stack.length > 0) {
    const current = stack.pop()
    for (const entry of readdirSync(current)) {
      // 跳过 node_modules、dist、测试文件、api.ts barrel
      if (isExcluded(entry)) continue
      if (entry.isDirectory()) stack.push(entry)
      else files.push(entry)
    }
  }
  return files
}

// 规则 1: 扩展不能 import openclaw/plugin-sdk 根路径
it("keeps bundled extension source files off root plugin-sdk imports", () => {
  for (const file of collectExtensionSourceFiles()) {
    const text = readSource(file)
    // 禁止: import { ... } from "openclaw/plugin-sdk"
    expect(text).not.toMatch(/["']openclaw\/plugin-sdk["']/)
    // 禁止: import { ... } from "openclaw/plugin-sdk/compat"
    expect(text).not.toMatch(/["']openclaw\/plugin-sdk\/compat["']/)
  }
})

// 规则 2: 核心代码不能 import 扩展私有 src
it("keeps core production files off extension private src imports", () => {
  for (const file of collectCoreSourceFiles()) {
    const text = readSource(file)
    expect(text).not.toMatch(/["'][^"']*extensions\/[^/"']+\/src\//)
  }
})

// 规则 3: 扩展不能 import 其他扩展的私有 src
it("keeps extension files off other extensions' private src imports", () => {
  for (const file of collectExtensionSourceFiles()) {
    const text = readSource(file)
    for (const specifier of collectImportSpecifiers(text)) {
      const targetExtension = resolveTargetExtension(specifier)
      if (targetExtension && targetExtension !== currentExtension) {
        fail(`${file} should not import ${specifier}`)
      }
    }
  }
})

// 规则 4: 扩展内部文件通过本地 api barrel 而非直接 plugin-sdk
it("keeps internalized helpers behind local api barrels", () => {
  for (const extensionId of LOCAL_EXTENSION_API_BARREL_GUARDS) {
    for (const file of collectExtensionFiles(extensionId)) {
      const text = readSource(file)
      expect(text).not.toMatch(
        new RegExp(`["']openclaw/plugin-sdk/${extensionId}["']`)
      )
    }
  }
})
```

### 2. 飞书消息清洗 (`sanitizeFeishuTextForDelivery`)

```javascript
function sanitizeFeishuTextForDelivery(text) {
  // 调用通用的指令标签剥离
  // 移除 [[reply_to_current]]、[[audio_as_voice]]、[[reply_to:xxx]] 等
  return stripInlineDirectiveTagsForDelivery(text).text
}

// 在所有消息发送入口调用
async function sendMessageFeishu({ text, ... }) {
  let rawText = sanitizeFeishuTextForDelivery(text ?? "")
  // ... 构建消息内容
}

async function editMessageFeishu({ text, messageId, ... }) {
  const normalizedText = sanitizeFeishuTextForDelivery(text)
  // ... 更新消息
}

function buildMarkdownCard(text) {
  const normalizedText = sanitizeFeishuTextForDelivery(text)
  // ... 构建卡片
}

function buildStructuredCard(text, options) {
  const normalizedText = sanitizeFeishuTextForDelivery(text)
  // ... 构建结构化卡片
}
```

### 3. Silent Token 尾片段检测

```javascript
function isSilentReplyTailFragmentText(text, token = "NO_REPLY") {
  const trimmed = text.trim()
  if (!trimmed) return false

  // 必须全大写
  if (trimmed !== trimmed.toUpperCase()) return false

  // 必须以 _ 开头（尾片段特征）
  if (!trimmed.startsWith("_")) return false

  // 长度必须小于完整 token
  if (trimmed.length >= token.length) return false

  // 不能是纯字母字符（排除完整单词）
  if (/^[A-Z]+$/.test(trimmed)) return false

  // 完整 token 必须以该片段结尾
  return token.toUpperCase().endsWith(trimmed.toUpperCase())
  // 例如: "_REPLY" 是 "NO_REPLY" 的尾片段 → true
}
```

### 4. Draft-Chunking 配置迁移

```javascript
function resolveDiscordDraftStreamingChunking(cfg, accountId) {
  const accountCfg = resolveAccountEntry(cfg?.channels?.discord?.accounts, accountId)

  // 新路径: streaming.preview.chunk
  const newPath = resolveChannelStreamingPreviewChunk(accountCfg) ??
                  resolveChannelStreamingPreviewChunk(cfg?.channels?.discord)

  // Legacy fallback: draftChunk (需要类型断言绕过类型系统)
  const accountLegacy = (accountCfg as { draftChunk?: unknown })?.draftChunk
  const channelLegacy = (cfg?.channels?.discord as { draftChunk?: unknown })?.draftChunk

  // 优先级: account 新路径 > channel 新路径 > account 旧路径 > channel 旧路径
  const draftCfg = (newPath ?? accountLegacy ?? channelLegacy) as DraftChunkConfig | undefined

  return { minChars: draftCfg?.minChars ?? 200, maxChars: draftCfg?.maxChars ?? 800 }
}
```

## 数据流程图 (Data Flow Diagram)

### Plugin-SDK 导出层级结构

```
┌───────────────────────────────────────────────────────────────┐
│                   扩展 (extensions/*)                          │
│                                                               │
│  extensions/feishu/src/send.ts                                │
│  extensions/feishu/src/thread-bindings.manager.ts             │
│  extensions/discord/src/draft-chunking.ts                     │
│  extensions/mattermost/channel-plugin-api.ts                  │
│            │                                                  │
│            │ import from                                       │
│            ▼                                                  │
│  ┌───────────────────────────────────────────────────────┐    │
│  │  扩展本地 barrel (api.ts / runtime-api.ts)             │    │
│  │  或 openclaw/plugin-sdk/<subpath>                      │    │
│  └───────────────────────┬───────────────────────────────┘    │
└──────────────────────────┼────────────────────────────────────┘
                           │
                           ▼
┌───────────────────────────────────────────────────────────────┐
│              Plugin SDK 公共表面                                │
│                                                               │
│  src/plugin-sdk/index.ts          src/plugin-sdk/feishu.ts    │
│  ┌─────────────────────┐          ┌─────────────────────────┐ │
│  │ 通用导出:            │          │ 飞书特化导出:            │ │
│  │ · SessionBinding*    │          │ · getGlobalHookRunner   │ │
│  │ · DiagnosticEvent*   │          │ · getLiveSession-       │ │
│  │ · detectMime         │          │   TranscriptEntries     │ │
│  │ · listSkillCommands  │          │ · appendAssistant-      │ │
│  │ · registerLogTrans.  │          │   MessageToTranscript   │ │
│  │ · clamp/sleep/etc    │          │ · loadSessionStore      │ │
│  │ · onDiagnosticEvent  │          │ · stripEnvelopeFrom-    │ │
│  │ · emitDiagnosticEvt  │          │   Message               │ │
│  └──────────┬──────────┘          └────────────┬────────────┘ │
└─────────────┼───────────────────────────────────┼─────────────┘
              │ re-export from                    │
              ▼                                   ▼
┌───────────────────────────────────────────────────────────────┐
│                     核心代码 (src/*)                            │
│                                                               │
│  src/infra/outbound/session-binding-service.ts                │
│  src/infra/diagnostic-events.ts                               │
│  src/media/mime.ts                                            │
│  src/logging/logger.ts                                        │
│  src/agents/pi-embedded-runner/live-session-registry.ts       │
│  src/config/sessions.ts                                       │
│  src/gateway/chat-sanitize.ts                                 │
└───────────────────────────────────────────────────────────────┘
```

### 通道导入护栏守护的 Boundary

```
  ┌──────────────────────────┐
  │   extensions/discord/    │──── src/*.ts (私有)
  │   extensions/telegram/   │──── api.ts / runtime-api.ts (公共 barrel)
  │   extensions/feishu/     │──── channel-plugin-api.ts (公共 barrel)
  │   extensions/mattermost/ │──── index.ts / setup-entry.ts
  │   ...22 个 channel ext   │
  └──────────┬───────────────┘
             │
             │ 护栏规则 (channel-import-guardrails.test.ts)
             │
    ╔════════════════════════════════════════════════════════╗
    ║  禁止: ext → openclaw/plugin-sdk (根路径)              ║
    ║  禁止: ext → openclaw/plugin-sdk/compat               ║
    ║  禁止: ext/A/src → ext/B/src (跨扩展私有 src)          ║
    ║  禁止: core/src → ext/*/src (核心访问扩展私有)          ║
    ║  禁止: ext 内部文件 → openclaw/plugin-sdk/<self>       ║
    ║         (应通过本地 api barrel)                         ║
    ║  禁止: ext → src/infra/outbound/send-deps              ║
    ║  禁止: shared.ts → openclaw/plugin-sdk/<same-channel>  ║
    ║  禁止: setup 文件 → formatCliCommand/formatDocsLink    ║
    ╚════════════════════════════════════════════════════════╝
             │
             ▼
  ┌──────────────────────────┐
  │   src/ (核心代码)         │
  │   src/plugin-sdk/ (SDK)  │
  └──────────────────────────┘
```

### 飞书消息清洗流程

```
  用户消息 + agent 回复
  "[[reply_to_current]] hello world"
       │
       ▼
  sanitizeFeishuTextForDelivery()
       │
       ▼
  stripInlineDirectiveTagsForDelivery()
       │
       ├─ 移除 [[reply_to_current]]
       ├─ 移除 [[reply_to: xxx]]
       ├─ 移除 [[audio_as_voice]]
       │
       ▼
  "hello world"
       │
       ├──→ sendMessageFeishu()  → 发送到飞书
       ├──→ editMessageFeishu()  → 编辑飞书消息
       ├──→ buildMarkdownCard()  → 构建卡片
       └──→ buildStructuredCard() → 构建结构化卡片
```

## 参考代码行号 (Reference Line Numbers)

| 文件 | 行号 | 内容 |
|------|------|------|
| `src/plugin-sdk/index.ts` | 88-155 | 新增导出块：session binding service、diagnostic events、mime、skill commands、utils |
| `src/plugin-sdk/feishu.ts` | 71-82 | 新增导出：`getGlobalHookRunner`、session transcript、session store 操作、`stripEnvelopeFromMessage` |
| `src/plugin-sdk/channel-import-guardrails.test.ts` | 1-502 | 完整的 import boundary 护栏测试文件 |
| `src/plugin-sdk/channel-import-guardrails.test.ts` | 8-27 | `ALLOWED_EXTENSION_PUBLIC_SURFACES`：允许的扩展公共表面白名单 |
| `src/plugin-sdk/channel-import-guardrails.test.ts` | 28-50 | `GUARDED_CHANNEL_EXTENSIONS`：22 个受保护的 channel 扩展列表 |
| `src/plugin-sdk/channel-import-guardrails.test.ts` | 408-420 | "keeps bundled extension source files off root plugin-sdk imports" 测试 |
| `src/plugin-sdk/channel-import-guardrails.test.ts` | 430-438 | "keeps core production files off extension private src imports" 测试 |
| `src/plugin-sdk/channel-import-guardrails.test.ts` | 446-456 | "keeps core extension imports limited to approved public surfaces" 测试 |
| `extensions/mattermost/channel-plugin-api.ts` | 1 | `export { mattermostPlugin } from "./src/channel.js"` |
| `extensions/mattermost/index.ts` | 21 | plugin specifier 改为 `./channel-plugin-api.js` |
| `extensions/feishu/src/send.ts` | 39-41 | `sanitizeFeishuTextForDelivery`：调用 `stripInlineDirectiveTagsForDelivery` |
| `extensions/feishu/src/send.ts` | 587 | `sendMessageFeishu` 入口处调用清洗 |
| `extensions/feishu/src/send.ts` | 674 | `editMessageFeishu` card 路径调用清洗 |
| `extensions/feishu/src/send.ts` | 740 | `buildMarkdownCard` 入口处调用清洗 |
| `extensions/feishu/src/send.ts` | 787 | `buildStructuredCard` 入口处调用清洗 |
| `extensions/discord/src/draft-chunking.ts` | 10-14 | `DraftChunkConfig` 本地类型定义（替代旧的隐式类型） |
| `extensions/discord/src/draft-chunking.ts` | 29-33 | 新配置路径 + legacy fallback 的优先级链 |
| `src/auto-reply/tokens.ts` | 116-147 | `isSilentReplyTailFragmentText`：尾片段检测完整实现 |
| `src/auto-reply/reply/agent-runner-execution.ts` | 631-633 | silent token 尾片段跳过 |
| `src/auto-reply/reply/agent-runner-execution.ts` | 647-653 | 纯空白 streaming delta 透传（不 trim） |
| `src/auto-reply/status.ts` | 444-466 | `formatCliPromptLoadLine`：chunk-aware 状态行渲染 |
| `src/auto-reply/status.ts` | 845-870 | last runtime model 行：配置模型 vs 实际运行模型 |
| `src/agents/cli-runner/execute.ts` | 169-219 | `extractLastReadLineNumber` + `isCompletePromptFileRead` 行号验证（替代 EOF marker） |
| `test/helpers/plugins/plugin-runtime-mock.ts` | 74-85 | `agents` 和 `hooks` mock 属性补充 |
| `src/plugins/contracts/plugin-sdk-index.test.ts` | 99-124 | 更新的 runtime exports 白名单（20 个新增项） |
