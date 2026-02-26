# Gateway 重启 + Session 过期导致记忆丢失分析

## 背景

OpenClaw 的记忆系统基于 Markdown 文件（`MEMORY.md` + `memory/*.md`）。模型只"记住"写入磁盘的内容。记忆写入依赖以下触发时机：

1. **模型主动写入** — 用户要求或模型判断需要记录时，通过文件工具写入
2. **Memory flush** — 会话接近 compaction 阈值时，自动触发静默 agent turn 提示写入
3. **`/new` 命令 hook** — `session-memory` hook 保存上一个会话的最近 15 条消息摘要

问题在于：如果 gateway 崩溃或重启，且 memory flush 尚未触发，记忆可能彻底丢失。

## 记忆写入时机的局限

### Memory flush 只在 compaction 阈值附近触发

`src/auto-reply/reply/memory-flush.ts:113` 的 `shouldRunMemoryFlush`：

```
触发条件: totalTokens >= contextWindow - reserveTokensFloor - softThresholdTokens
```

- 默认 `softThresholdTokens = 4000`
- 每次 compaction 周期只触发一次
- 沙箱只读模式下跳过
- CLI provider 下跳过

对于短对话（远未达到 compaction 阈值），flush 永远不会触发。

### 关机流程无记忆写入

优雅关机（SIGTERM/SIGINT/SIGUSR1）流程 (`src/cli/gateway-cli/run-loop.ts:40-112`)：

1. restart 时 drain 当前活跃的 agent turn（最多等 30 秒）
2. 调用 `server.close()` 关闭 channel、WebSocket、HTTP 等
3. **没有** "关机前强制 memory flush" 的逻辑

`src/gateway/server-close.ts` 的 `createGatewayCloseHandler` 中没有任何记忆相关的清理。

崩溃场景（OOM、kill -9）下更是没有任何 cleanup。

## Session 重启后的两条路径

当 gateway 重启后用户发来消息时，`src/auto-reply/reply/session.ts:initSessionState` 会评估 session freshness。

### 路径 A：Session 未过期（fresh）— 对话恢复

如果 `evaluateSessionFreshness` 判定 fresh（未超过 idle timeout 和 daily reset 时间）：

- 复用旧 session entry（包括 `sessionId`、`sessionFile`）
- pi-agent 从磁盘上的 `.jsonl` transcript 加载对话历史
- **对话上下文恢复**，之前的内容在上下文中可见

但记忆文件仍然没有被写入——如果后续 session 再次过期，同样的问题会重演。

### 路径 B：Session 已过期（stale）— 记忆彻底丢失

如果超过 idle timeout (`idleMinutes`) 或跨越 daily reset 时间：

```
gateway 重启 → 用户发消息 → evaluateSessionFreshness → stale → isNewSession = true
```

关键代码路径 (`src/auto-reply/reply/session.ts:209`)：

```typescript
const previousSessionEntry = resetTriggered && entry ? { ...entry } : undefined;
```

`previousSessionEntry` **只在 `resetTriggered` 为 true 时有值**。静默过期时 `resetTriggered = false`。

这导致以下所有保护机制全部跳过：

| 机制                  | 依赖条件                                | 静默过期时         |
| --------------------- | --------------------------------------- | ------------------ |
| `session-memory` hook | `event.action === "new"` (command 事件) | 不触发             |
| `session_end` hook    | `previousSessionEntry?.sessionId`       | 不触发 (undefined) |
| Transcript 归档       | `previousSessionEntry?.sessionId`       | 不执行             |

结果：

- 旧 transcript `.jsonl` 留在磁盘上成为**孤儿文件**（不删除也不重命名）
- 新 session 拿到新 `sessionId` + 新 transcript 文件
- Session store 中旧 entry 被新 entry 覆盖，`sessionFile` 指向新文件
- **Agent 无法访问旧对话内容**

## 对比：`/new` 命令 vs 静默过期

|                        | `/new` 命令                        | 静默过期 (idle/daily) |
| ---------------------- | ---------------------------------- | --------------------- |
| `resetTriggered`       | `true`                             | `false`               |
| `previousSessionEntry` | 有值                               | `undefined`           |
| `session-memory` hook  | 触发，保存最近 15 条消息           | 不触发                |
| `session_end` hook     | 触发                               | 不触发                |
| Transcript 归档        | 执行 (`.reset.*`)                  | 不执行（变孤儿）      |
| 记忆写入               | 有 (`memory/YYYY-MM-DD-<slug>.md`) | 无                    |

## 丢失链条

```
gateway 崩溃/长时间宕机
  → 对话还没到 compaction 阈值，memory flush 未触发
  → 重启后 session idle 过期
  → 新 session 创建，resetTriggered=false
  → previousSessionEntry = undefined
  → session-memory hook 不触发
  → session_end hook 不触发
  → 旧 transcript 变孤儿文件
  → 记忆彻底丢失（agent 不可达）
```

## 部分缓解：实验性 Session Memory Search

如果显式开启实验性 session transcript 索引：

```json5
agents: {
  defaults: {
    memorySearch: {
      experimental: { sessionMemory: true },
      sources: ["memory", "sessions"]
    }
  }
}
```

`src/memory/manager-sync-ops.ts:708` 中 `listSessionFilesForAgent()` 扫描 sessions 目录下**所有** `.jsonl` 文件，包括孤儿文件。这些文件会被索引进向量数据库，`memory_search` 能搜到旧对话内容。

但这是默认关闭的实验功能，大部分用户不会开启。

QMD 后端的 `memory.qmd.sessions.enabled = true` 也能覆盖此场景。

## 可能的改进方向

1. **关机前强制 memory flush** — 在 `createGatewayCloseHandler` 或 `runGatewayLoop` 的 shutdown 流程中，对活跃 session 触发一次 memory flush
2. **静默过期时触发 session-memory hook** — 当 `evaluateSessionFreshness` 判定 stale 且有旧 entry 时，也设置 `previousSessionEntry` 并触发 hook
3. **默认开启 session transcript 索引** — 让 `memory_search` 默认能搜到旧 session 内容
4. **定期 memory flush** — 不只在 compaction 阈值附近触发，增加基于时间间隔的定期 flush（例如每 N 分钟或每 N 条消息）

## 相关代码

- Session 初始化与 freshness 判定: `src/auto-reply/reply/session.ts`
- Session freshness 计算: `src/config/sessions/reset.ts:139`
- Memory flush 触发条件: `src/auto-reply/reply/memory-flush.ts:113`
- Memory flush 执行: `src/auto-reply/reply/agent-runner-memory.ts`
- Session-memory hook: `src/hooks/bundled/session-memory/handler.ts`
- Gateway 关机流程: `src/gateway/server-close.ts`
- Gateway 信号处理: `src/cli/gateway-cli/run-loop.ts`
- Memory index 同步: `src/memory/manager-sync-ops.ts`
- Transcript 归档: `src/gateway/session-utils.fs.ts`
