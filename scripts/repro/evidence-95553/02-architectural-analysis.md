# 架构分析 (Architectural Analysis)

## 问题: 预飞压缩的超时绑定错误

---

### 1. 信号传递链 (Signal Chain)

#### 修复前 (BEFORE)

```
ReplyOperation (AbortController)
  ↓ abortSignal  ← 在 ~60s 内可能被 abort (用户取消/重启/上游超时)
  ↓
preflightCompaction()
  ↓ 传入
compactEmbeddedAgentSession()
  ↓ 传入
compactWithSafetyTimeout()        ← 自身有 180s safety timeout
  ↓ composeAbortSignals()
  180s timeout ⊕ replyOperation signal  ← reply signal 更短，导致提前中止
```

**问题**: `compactWithSafetyTimeout` 本身已有 180s 超时保护，但外部 `replyOperation.abortSignal` 在 ~60s 内可能因回复生命周期结束而触发 abort，导致 `composeAbortSignals` 提前中止压缩。大会话需要超过 60s 压缩时，总是被杀死。

#### 修复后 (AFTER) — AbortSignal.any 组合方案

```
replyOperation.abortSignal (用户取消/重启)
  ↓
AbortSignal.any([
  replyOp.signal,          ← 显式取消事件
  AbortSignal.timeout(180s) ← 压缩定时
])
  ↓
preflightCompaction()
  ↓ 传入 compactEmbeddedAgentSession()
compactWithSafetyTimeout(180s timeout)
  ↓ composeAbortSignals()
  180s timeout ⊕ any[replyOp, 180s_timeout]
  = 压缩受 180s 超时保护，同时保留显式取消能力
```

**修复**: 使用 `AbortSignal.any()` 组合两个信号：

- `replyOperation.abortSignal` — 保留用户主动取消/重启的取消能力
- `AbortSignal.timeout(180s)` — 取代上游网关超时 (~60s) 成为压缩的定时边界

内存刷新和 agent 执行路径保持不变，仍使用原始的 `replyOperation.abortSignal`。

---

### 2. 关键源码位置 (Key Source Locations)

| 组件                       | 文件                           | 行号         | 说明                                                                 |
| -------------------------- | ------------------------------ | ------------ | -------------------------------------------------------------------- |
| ReplyOperation abortSignal | `reply-run-registry.ts`        | 388, 469-471 | `AbortController` + `controller.signal`                              |
| 预飞压缩                   | `agent-runner-memory.ts`       | 947-986      | 调用 `compactEmbeddedAgentSession`                                   |
| 修复代码                   | `agent-runner-memory.ts`       | 988-991      | `AbortSignal.any([replyOp.signal, AbortSignal.timeout(180s)])`       |
| 超时解析                   | `compaction-safety-timeout.ts` | 59-65        | `resolveCompactionTimeoutMs()` 解析 `compaction.timeoutSeconds`      |
| 安全超时包装               | `compaction-safety-timeout.ts` | 67-137       | `compactWithSafetyTimeout()` 包装+信号组合                           |
| 核心压缩                   | `compact.ts`                   | 1460-1472    | `compactEmbeddedAgentSessionDirectOnce` → `compactWithSafetyTimeout` |

---

### 3. `resolveCompactionTimeoutMs` 行为

- **默认值**: `EMBEDDED_COMPACTION_TIMEOUT_MS = 180_000` (180s)
- **配置键**: `cfg.agents.defaults.compaction.timeoutSeconds`
- **优先级**: 配置值 → 有限秒数转毫秒(向下取整) → 默认 180000ms
- **代码**: `compaction-safety-timeout.ts:59-65`

```typescript
export function resolveCompactionTimeoutMs(cfg?: OpenClawConfig): number {
  return (
    finiteSecondsToTimerSafeMilliseconds(cfg?.agents?.defaults?.compaction?.timeoutSeconds, {
      floorSeconds: true,
    }) ?? EMBEDDED_COMPACTION_TIMEOUT_MS
  );
}
```

---

### 4. `compactWithSafetyTimeout` 的信号组合

`compactWithSafetyTimeout` 使用 `composeAbortSignals` 将 internal timeout signal 和 external `abortSignal` 组合：

```typescript
const composedAbortSignal = composeAbortSignals(timeoutSignal, abortSignal);
```

修复前，`abortSignal = replyOperation.abortSignal`（回复操作生命周期，~60s）。
修复后，`abortSignal = AbortSignal.timeout(180000)`（配置的压缩超时，默认 180s）。

两路信号都超时 180s，意味着只有真正超时时才会中止，不会因回复生命周期提前结束。
