# 修复前后代码对比 (Before/After Diff)

## Issue #95553 — Preflight Compaction Timeout

---

### 文件: `src/auto-reply/reply/agent-runner-memory.ts`

#### 变更摘要: +1 导入, +4 行注释/逻辑, -1 行旧代码

#### Import 新增

```diff
+ import { resolveCompactionTimeoutMs } from "../../agents/embedded-agent-runner/compaction-safety-timeout.js";
```

#### 核心修复 (第 979-986 行)

```diff
       ownerNumbers: params.followupRun.run.ownerNumbers,
-      abortSignal: params.replyOperation.abortSignal,
+      // Preflight compaction uses the configured compaction timeout instead of
+      // the reply operation's abort signal (~60s) so that slow compaction on
+      // large sessions can complete (issue #95553).
+      abortSignal: AbortSignal.timeout(resolveCompactionTimeoutMs(params.cfg)),
     });
```

---

### 不受影响的其他路径

文件中有 3 处 `abortSignal: params.replyOperation.abortSignal`，本次修复只改了 **预飞压缩 (preflight compaction)** 这一处。其余两处保持原样：

1. **预飞压缩** (第 985 行) — **已修复**: 改用配置超时
2. **内存刷新 (memory flush)** (第 1322 行) — 保持 `replyOperation.abortSignal`: 内存刷新应在回复取消时终止
3. **Agent 执行** (第 1368 行) — 保持 `replyOperation.abortSignal`: agent 执行应在回复取消时终止
