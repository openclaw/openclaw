# Patch 05: 自动回复分发加固 — toolCallId 透传、最终载荷去重、流式指令处理

## 为什么要改 (Why)

### 问题 1: toolCallId 在回复管线中丢失

CLI runner 返回的 `toolCallId`（标识每次 tool 调用的唯一 ID）在 `runReplyAgent` → `persistSessionUsageUpdate` → session store 的传递链中没有正确透传。下游的 Feishu streaming card、tool 结果关联、以及 session 状态持久化都无法知道当前回复对应哪个 tool call。

### 问题 2: 最终回复载荷重复发送

当 CLI runner 返回多个 payload 时（例如 streaming 最终文本 + tool result 文本），`dispatchReplyFromConfig` 的 `sendFinalPayload` 循环可能把内容相同但 mention tag 格式不同的文本（`<at user_id="x">` vs `<at id=x>`）重复发送给用户。

### 问题 3: abort 流程未覆盖 CLI 进程

用户发送 `/stop` 时，`tryFastAbortFromMessage` 和 `stopSubagentsForRequester` 只终止了 embedded Pi runner，CLI 子进程继续运行直到超时。需要通过 `ProcessSupervisor.cancelSession()` 同时杀死关联的 CLI 子进程。

### 问题 4: 流式 silent token 分片匹配不正确

当 `NO_REPLY` 等 silent token 被 streaming 分片切割（例如 "NO" + "_REPLY"）时，旧的 `StreamingDirectiveAccumulator` 不会缓冲前缀，导致 "NO" 被当作普通文本发出，而后续的 "_REPLY" 无法匹配完整 token。

## 改了什么 (What Changed)

| 文件 | 关键修改 |
|------|----------|
| `src/auto-reply/reply/abort.ts` | 新增 `abortSessionExecutions()`：ProcessSupervisor cancel + embedded abort |
| `src/auto-reply/reply/agent-runner.ts` | `runReplyAgent` 透传 `cliSessionId` / `cliSessionBinding` / `cliPromptLoad` |
| `src/auto-reply/reply/agent-runner-execution.ts` | 移除内联 streaming 回调，whitespace delta 直通 |
| `src/auto-reply/reply/dispatch-from-config.ts` | 最终载荷去重：mention 标签归一化后 Set 比对 |
| `src/auto-reply/reply/followup-runner.ts` | 切换到 `runModelAwareAgent`，透传 CLI session 状态 |
| `src/auto-reply/reply/get-reply.ts` | 移除 lazy import `sessionResetModelRuntime`，新增 auto-rotation reset hooks |
| `src/auto-reply/reply/streaming-directives.ts` | `pendingSilent` 缓冲机制：正确处理分片 silent token |
| `src/auto-reply/reply/session-usage.ts` | `applyCliSessionStateToSessionPatch()`：CLI session 状态写入 session store |
| `src/auto-reply/reply/session.ts` | session hooks context 微调 |
| `src/auto-reply/reply/commands-core.ts` | 命令处理透传 toolCallId |
| `src/auto-reply/reply/commands-session-abort.ts` | abort 命令适配新 `abortSessionExecutions` |
| `src/auto-reply/status.ts` | CLI prompt load 状态合并到 status 输出 |
| `src/auto-reply/heartbeat.ts` | heartbeat 微调 |
| `src/auto-reply/types.ts` | `ReplyPayload` 类型扩展 `toolCallId` |

## 伪代码 (Pseudocode)

### 1. abort 流程加固 (`abortSessionExecutions`)

```javascript
function abortSessionExecutions(sessionId) {
  if (!sessionId?.trim()) {
    return { embeddedAborted: false, cliCancelled: 0 };
  }

  // 1. 终止 embedded Pi runner（原有逻辑）
  const embeddedAborted = abortEmbeddedPiRun(sessionId);

  // 2. 通过 ProcessSupervisor 杀死 CLI 子进程（新增）
  let cliCancelled = 0;
  try {
    cliCancelled = getProcessSupervisor()
      .cancelSession(sessionId, "manual-cancel");
  } catch (error) {
    logVerbose(`abort: supervisor cancel failed: ${error.message}`);
  }

  return { embeddedAborted, cliCancelled };
}

// 在 tryFastAbortFromMessage 中使用：
async function tryFastAbortFromMessage(params) {
  // ... 解析目标 session ...
  const registryAborted = replyRunRegistry.abort(targetKey)
    || (sessionId ? abortEmbeddedPiRun(sessionId) : false);

  // 新增：同时 cancel CLI 进程
  const { embeddedAborted, cliCancelled } = abortSessionExecutions(sessionId);
  const aborted = registryAborted || embeddedAborted || cliCancelled > 0;

  // ... 清理队列、发送 abort 确认 ...
}
```

### 2. 最终载荷去重 (`dispatchReplyFromConfig`)

```javascript
async function dispatchReplyFromConfig(params) {
  const replies = Array.isArray(replyResult) ? replyResult : [replyResult];

  // mention 标签归一化函数
  const normalizeMentionsForDedup = (text) =>
    text
      // <at user_id="ou_xxx">Name</at> → <at:ou_xxx>
      .replace(/<at\s+user_id="([^"]+)">[^<]*<\/at>/g, "<at:$1>")
      // <at id="ou_xxx"></at> → <at:ou_xxx>
      .replace(/<at\s+id=(?:"([^"]+)"|'([^']+)'|([^>\s]+))><\/at>/g,
        "<at:$1$2$3>")
      .trim();

  const deliveredFinalTexts = new Set();

  for (const reply of replies) {
    // 跳过 reasoning payload
    if (reply.isReasoning) continue;

    // 去重：归一化后比对
    if (reply.text) {
      const normalized = normalizeMentionsForDedup(reply.text);
      if (deliveredFinalTexts.has(normalized)) continue;
      deliveredFinalTexts.add(normalized);
    }

    // TTS 处理 + 路由分发
    const ttsReply = await maybeApplyTtsToReplyPayload({ payload: reply, ... });
    if (shouldRouteToOriginating) {
      await routeReply({ payload: ttsReply, channel, to, ... });
    } else {
      dispatcher.sendFinalReply(ttsReply);
    }
  }
}
```

### 3. 流式 silent token 缓冲 (`StreamingDirectiveAccumulator`)

```javascript
function createStreamingDirectiveAccumulator() {
  let pendingTail = "";
  let pendingSilent = "";  // 新增：silent token 缓冲区

  function consume(raw, options = {}) {
    const silentToken = options.silentToken ?? "NO_REPLY";
    let normalizedRaw = raw ?? "";

    // 恢复之前缓冲的 silent 前缀
    if (pendingSilent) {
      const resumed = pendingSilent + normalizedRaw;
      pendingSilent = "";

      // 仍然可能是 silent token 的前缀？继续缓冲
      if (!options.final && couldBeSilentTokenStart(resumed, silentToken)) {
        pendingSilent = resumed;
        return null;  // 不输出任何内容
      }

      // 完整匹配 silent token → 吞掉
      if (isSilentReplyText(resumed, silentToken)) {
        return null;
      }

      // 不是 silent token → 作为正常文本释放
      normalizedRaw = resumed;
    }

    let combined = pendingTail + normalizedRaw;
    pendingTail = "";

    // 新文本本身可能是 silent token 前缀
    if (!options.final && couldBeSilentTokenStart(combined, silentToken)) {
      pendingSilent = combined;
      return null;
    }

    return parseChunk(combined, { silentToken });
  }

  return { consume, reset };
}
```

### 4. CLI session 状态持久化 (`applyCliSessionStateToSessionPatch`)

```javascript
function applyCliSessionStateToSessionPatch(params, entry, patch) {
  const nextPatch = { ...patch };

  // 写入 CLI prompt load 状态
  if (params.cliPromptLoad) {
    nextPatch.cliPromptLoad = params.cliPromptLoad;
  }

  const cliProvider = params.providerUsed ?? entry.modelProvider;
  if (!cliProvider) return nextPatch;

  // 方式 1：完整的 session binding（含 prompt file hash）
  if (params.cliSessionBinding?.sessionId?.trim()) {
    const nextEntry = { ...entry, ...patch };
    setCliSessionBinding(nextEntry, cliProvider, params.cliSessionBinding);
    return {
      ...nextPatch,
      cliSessionBindings: nextEntry.cliSessionBindings,
      cliSessionIds: nextEntry.cliSessionIds,
      claudeCliSessionId: nextEntry.claudeCliSessionId,
    };
  }

  // 方式 2：仅 session ID（无 binding 元数据）
  if (params.cliSessionId) {
    const nextEntry = { ...entry, ...patch };
    setCliSessionId(nextEntry, cliProvider, params.cliSessionId);
    return {
      ...nextPatch,
      cliSessionIds: nextEntry.cliSessionIds,
      claudeCliSessionId: nextEntry.claudeCliSessionId,
    };
  }

  return nextPatch;
}
```

## 数据流程图 (Data Flow Diagram)

### toolCallId 透传路径

```
┌─────────────────────────┐
│  CLI Runner 执行结果     │
│  result.meta.agentMeta  │
│    .cliSessionId        │
│    .cliSessionBinding   │
│    .cliPromptLoad       │
│    .usage               │
└────────┬────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────┐
│  runReplyAgent()                                    │
│  src/auto-reply/reply/agent-runner.ts:526           │
│                                                     │
│  cliSessionId = isCliProvider(providerUsed, cfg)    │
│    ? runResult.meta.agentMeta.sessionId.trim()      │
│    : undefined                                      │
│  cliSessionBinding = runResult.meta.agentMeta       │
│    .cliSessionBinding                               │
└────────┬────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────┐
│  persistSessionUsageUpdate()                        │
│  src/auto-reply/reply/session-usage.ts:97           │
│                                                     │
│  params: { cliSessionId, cliSessionBinding,         │
│            cliPromptLoad, usageIsContextSnapshot }  │
│                                                     │
│  → applyCliSessionStateToSessionPatch()             │
│    → setCliSessionBinding() / setCliSessionId()     │
│    → updateSessionStoreEntry(patch)                 │
└─────────────────────────────────────────────────────┘
         │
         ▼
┌────────────────────────┐
│  Session Store (disk)  │
│  .cliSessionIds        │
│  .cliSessionBindings   │
│  .claudeCliSessionId   │
│  .cliPromptLoad        │
└────────────────────────┘
```

### abort 流程（加固后）

```
     用户发送 /stop
           │
           ▼
┌──────────────────────────────────────────────┐
│  tryFastAbortFromMessage()                   │
│  src/auto-reply/reply/abort.ts:331           │
│                                              │
│  1. replyRunRegistry.abort(targetKey)        │
│  2. abortEmbeddedPiRun(sessionId)            │
│  3. abortSessionExecutions(sessionId) ◄──新  │
│     │                                        │
│     ├─→ abortEmbeddedPiRun()                 │
│     └─→ ProcessSupervisor.cancelSession()    │
│          │                                   │
│          ▼                                   │
│     kill CLI child processes (SIGTERM)       │
└──────────────────────────────────────────────┘
           │
           ▼
┌──────────────────────────────────────────────┐
│  clearSessionQueues()                        │
│  followup queue + lane queue 清理            │
└──────────────────────────────────────────────┘
```

### 最终载荷去重流

```
CLI Runner 返回 payloads:
  [
    { text: "回复 <at user_id=\"ou_xxx\">Alice</at>" },   ← 格式 A
    { text: "回复 <at id=ou_xxx></at>" },                  ← 格式 B (同一内容)
    { text: "另一条回复" },                                ← 不同内容
  ]
       │
       ▼
┌──────────────────────────────────────────────────────┐
│  normalizeMentionsForDedup()                         │
│  src/auto-reply/reply/dispatch-from-config.ts:955    │
│                                                      │
│  格式 A → "回复 <at:ou_xxx>"                         │
│  格式 B → "回复 <at:ou_xxx>"   ← 同! → 跳过          │
│  格式 C → "另一条回复"          ← 不同 → 发送         │
└──────────────────────────────────────────────────────┘
       │
       ▼  只发送 2 条（而非 3 条）
┌──────────────────┐
│  Channel 分发    │
│  Feishu/Telegram │
└──────────────────┘
```

## 参考代码行号 (Reference Line Numbers)

| 文件 | 行号 | 内容 |
|------|------|------|
| `src/auto-reply/reply/abort.ts` | 46-71 | `abortSessionExecutions()`: 新增 ProcessSupervisor cancel 逻辑 |
| `src/auto-reply/reply/abort.ts` | 231-239 | `stopSubagentsForRequester` 集成 `abortSessionExecutions` |
| `src/auto-reply/reply/abort.ts` | 331-340 | `tryFastAbortFromMessage` 加入 CLI abort 分支 |
| `src/auto-reply/reply/agent-runner.ts` | 474-476 | 新增 `aborted` kind 处理：直接返回 `undefined` |
| `src/auto-reply/reply/agent-runner.ts` | 526-531 | 提取 `cliSessionId` + `cliSessionBinding` |
| `src/auto-reply/reply/agent-runner.ts` | 585-590 | 透传到 `persistSessionUsageUpdate`，`usageIsContextSnapshot` 按 provider 判定 |
| `src/auto-reply/reply/agent-runner-execution.ts` | 639-647 | whitespace delta 直通：跳过 sanitize 保留 markdown 空格 |
| `src/auto-reply/reply/agent-runner-execution.ts` | 750-794 | 移除内联 streaming 回调（已在 CLI runner 内部处理） |
| `src/auto-reply/reply/dispatch-from-config.ts` | 952-1012 | 最终载荷去重：mention 归一化 + Set 判重 + TTS + 路由分发 |
| `src/auto-reply/reply/followup-runner.ts` | 159-162 | 切换 `runEmbeddedPiAgent` → `runModelAwareAgent` |
| `src/auto-reply/reply/followup-runner.ts` | 287-295 | 提取 `providerUsed` / `cliSessionId` |
| `src/auto-reply/reply/followup-runner.ts` | 307-320 | 透传 CLI session 状态到 `persistSessionUsageUpdate` |
| `src/auto-reply/reply/get-reply.ts` | 244-265 | 新增 auto-rotation reset hooks：CLI provider 切换时触发 session reset |
| `src/auto-reply/reply/streaming-directives.ts` | 77-78 | 新增 `pendingSilent` 缓冲区变量 |
| `src/auto-reply/reply/streaming-directives.ts` | 87-105 | `consume()` 中 silent token 前缀缓冲与恢复 |
| `src/auto-reply/reply/streaming-directives.ts` | 120-145 | 完整 silent token 匹配 + 后置缓冲检测 |
| `src/auto-reply/reply/session-usage.ts` | 16-48 | `applyCliSessionStateToSessionPatch()`: CLI session 状态合并到 session patch |
| `src/auto-reply/reply/session-usage.ts` | 97-100 | `persistSessionUsageUpdate` 参数扩展 `cliSessionId` / `cliSessionBinding` / `cliPromptLoad` |
| `src/auto-reply/reply/session-usage.ts` | 170 | 在 totalTokens 写入后调用 `applyCliSessionStateToSessionPatch` |
