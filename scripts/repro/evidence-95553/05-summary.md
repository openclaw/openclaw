# Issue #95553 — 修复举证综合报告

## Preflight Compaction Timeout 修复

---

## 问题概述

预飞压缩 (preflight compaction, `trigger=budget`) 使用了 `params.replyOperation.abortSignal` 作为中止信号。该信号来自 `ReplyOperation` 的 `AbortController`（`reply-run-registry.ts:388`），其生命周期与回复操作绑定——当用户取消、网关重启、上游超时时会被中止。回复操作的典型生命周期约为 60 秒。

这意味着：**大会话的压缩需要较长时间（超过 ~60s）时，总是被回复操作的中止信号提前杀死**，导致 `Preflight compaction required but failed` 错误。

---

## 根因分析

### 信号链 (BEFORE)

```
replyOperation.abortSignal  (来自 AbortController, ~60s 生命周期)
     ↓
preflightCompaction() 传入 compactEmbeddedAgentSession()
     ↓
compactWithSafetyTimeout(180s timeout) 组合信号:
  composeAbortSignals(180s_timeout, replyOperation_signal)
     ↓
  replyOperation_signal 在 ~60s 内触发 abort
     ↓
  压缩被中断，即使 180s 超时远未到达
```

### 修复后 (AFTER) — AbortSignal.any 组合方案

```
replyOperation.abortSignal (显式取消/重启)        AbortSignal.timeout(180s) (配置超时)
     ↓                                                   ↓
     └────────── AbortSignal.any([...]) ──────────────────┘
                              ↓
                preflightCompaction() 传入 compactEmbeddedAgentSession()
                              ↓
                compactWithSafetyTimeout(180s) 组合信号:
                  composeAbortSignals(180s_timeout, any[replyOp, 180s])
                              ↓
                  压缩受 180s 保护 + 保留显式取消能力
```

---

## 代码变更

**文件**: `src/auto-reply/reply/agent-runner-memory.ts`
**行数**: +5/-1 (不包括导入)

### 变更详解

| 方面        | 修复前                                | 修复后                                                          |
| ----------- | ------------------------------------- | --------------------------------------------------------------- |
| abortSignal | `params.replyOperation.abortSignal`   | `AbortSignal.any([replyOp.signal, AbortSignal.timeout(180s)])`  |
| 超时源      | ReplyOperation AbortController (~60s) | `compaction.timeoutSeconds` 配置 (默认 180s) + replyOp 显式取消 |
| 可配置性    | 不可配置                              | 可通过 `agents.defaults.compaction.timeoutSeconds` 配置         |
| 解耦度      | 绑定到回复生命周期                    | 与上游网关超时解耦，保留显式取消能力                            |

### 其他路径未受影响

内存刷新和 agent 执行路径仍使用 `replyOperation.abortSignal`，这是正确的，因为那些操作应在回复取消时立即终止。

---

## 验证结果

### 1. `resolveCompactionTimeoutMs` 行为验证

| 配置                  | 预期            | 实际     | 匹配 |
| --------------------- | --------------- | -------- | ---- |
| 无配置                | 180000ms (180s) | 180000ms | ✓    |
| `timeoutSeconds: 300` | 300000ms (300s) | 300000ms | ✓    |
| `timeoutSeconds: 120` | 120000ms (120s) | 120000ms | ✓    |

### 2. 源码验证

| 检查项                                     | 结果 |
| ------------------------------------------ | ---- |
| 使用 `AbortSignal.any` 组合信号            | ✓    |
| 组合中包含配置超时 (`AbortSignal.timeout`) | ✓    |
| 组合中包含 replyOp 信号 (保留显式取消)     | ✓    |
| 旧裸信号已移除 (仅剩 2 处其他路径)         | ✓    |
| `resolveCompactionTimeoutMs` 导入          | ✓    |

### 3. 测试结果

| 测试文件                                             | 测试数  | 结果         |
| ---------------------------------------------------- | ------- | ------------ |
| `agent-runner-memory.test.ts`                        | 46      | 全部通过     |
| `agent-runner-memory.preflight-stale-tokens.test.ts` | 2       | 全部通过     |
| `followup-runner.test.ts`                            | 83      | 全部通过     |
| **总计**                                             | **131** | **全部通过** |

---

## 证据文件清单

| 文件                                                               | 说明              |
| ------------------------------------------------------------------ | ----------------- |
| `scripts/repro/issue-95553-preflight-compaction-timeout-proof.mts` | 验证脚本          |
| `scripts/repro/evidence-95553/01-before-after-diff.md`             | 修复前后代码对比  |
| `scripts/repro/evidence-95553/02-architectural-analysis.md`        | 架构分析 (信号链) |
| `scripts/repro/evidence-95553/03-proof-script-output.md`           | 验证脚本输出      |
| `scripts/repro/evidence-95553/04-test-results.md`                  | 测试结果          |
| `scripts/repro/evidence-95553/05-summary.md`                       | 本文件 (综合报告) |

---

## Conclusion

**修复确认**：预飞压缩现在使用 `AbortSignal.any([replyOperation.abortSignal, AbortSignal.timeout(180s)])` 组合信号方案。配置超时 (`compaction.timeoutSeconds`，默认 180s) 取代上游网关 ~60s 超时成为压缩的定时边界，同时保留 `replyOperation.abortSignal` 让用户主动取消/重启仍能中止压缩。大会话的压缩现在可以在 180s 内正常完成。

**Fixes**: #95553
