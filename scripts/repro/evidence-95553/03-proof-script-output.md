# 验证脚本输出 (Proof Script Output)

**脚本路径**: `scripts/repro/issue-95553-preflight-compaction-timeout-proof.mts`

**运行命令**:

```bash
node --import tsx scripts/repro/issue-95553-preflight-compaction-timeout-proof.mts
```

---

```
=== resolveCompactionTimeoutMs behavior ===
  default (no config):        180000ms (180s)
  expected default:           180000ms (180s)
  match:                      true
  custom 300s config:         300000ms (300s)
  expected:                   300000ms (300s)
  match:                      true
  custom 120s config:         120000ms (120s)
  expected:                   120000ms (120s)
  match:                      true

=== Preflight compaction abort signal verification ===

BEFORE fix:  abortSignal: params.replyOperation.abortSignal
             → ReplyOperation has a plain AbortController
             → aborted when reply lifecycle ends (~60s)
             → slow compaction on large sessions gets killed

AFTER fix:   AbortSignal.any([replyOp.signal, AbortSignal.timeout(180s)])
             → compose preserves user abort/restart cancellation
             → AbortSignal.timeout(180000) replaces ~60s lifecycle bound
             → respects compaction.timeoutSeconds config
             → slow compaction on large sessions can complete

=== Source code verification ===
  Uses AbortSignal.any compose:             YES ✓
  Config timeout in compose:                YES ✓
  ReplyOp signal in compose:                YES ✓
  Preflight no longer has bare old signal:  YES ✓
  Other replyOp.abortSignal occurrences:    2 (expected: 2 for memory flush + agent execution)
  Import of resolveCompactionTimeoutMs:      YES ✓

=== VERDICT: FIX CONFIRMED ===
Preflight compaction now composes:
  1. replyOperation.abortSignal — for user abort / restart cancellation
  2. AbortSignal.timeout(180s) — for compaction timing bound
via AbortSignal.any(), replacing the old bare replyOperation signal.
Memory flush and agent execution paths correctly keep the old signal.
Issue #95553 is resolved.
```

---

## 验证要点

1. **`resolveCompactionTimeoutMs` 函数行为验证**:
   - 无配置时返回 180000ms (180s) ✓
   - `compaction.timeoutSeconds: 300` 返回 300000ms ✓
   - `compaction.timeoutSeconds: 120` 返回 120000ms ✓

2. **`AbortSignal.any` 组合信号验证** ✓
   - 组合中包含 `replyOperation.abortSignal` ✓ (保留显式取消)
   - 组合中包含 `AbortSignal.timeout(180s)` ✓ (配置超时)

3. **旧裸信号已移除**: 预飞压缩路径不再有裸 `abortSignal: params.replyOperation.abortSignal` ✓
   - 现仅 2 处（内存刷新 + agent 执行）✓

4. **导入语句存在** ✓
