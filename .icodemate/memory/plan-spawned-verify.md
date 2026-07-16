# 独立验证子 session 实现方案

## 核心思路

串行和并行子任务的 verify 阶段，不再使用 `sendMessage(verifyPrompt)` 在主会话中执行，而是：
1. 通过 `callGateway({ method: "sessions.create", ... })` 创建独立子 session
2. 验证 prompt 作为初始消息自动发送
3. 轮询 `sessions.get` 等待助手回复
4. 从回复文本中提取 verdict（passed/false + 证据）
5. 清理 session

## 需要修改的文件

### 1. `src/auto-reply/reply/commands-loop.ts`

新增 `buildSpawnedVerifyPrompt()`：

```typescript
export function buildSpawnedVerifyPrompt(subtask: LoopSubtask): string {
  // 同 buildSerialVerifyPrompt，但末尾要求输出结构化 verdict 标记：
  // ---VERDICT---
  // passed: true
  // ---SUMMARY---
  // ...
  
  // 不再提示调用 loop_update，而是告诉 agent将其调查结果写在回复中
}
```

### 2. `src/tui/tui-command-handlers.ts`

新增 `spawnVerifySession()` 辅助函数：

```typescript
async function spawnVerifySession(
  prompt: string,
  agentId: string,
  timeoutMs?: number,
): Promise<{ passed: boolean; summary: string }>
```

替换串行循环中的验证步骤（`tui-command-handlers.ts:773-821`）：

```typescript
// Old: await sendMessage(verifyPrompt); await verifyWait;
// New:
const result = await spawnVerifySession(verifyPrompt, agentId);
// Use result.passed and result.summary directly
```

替换并行循环中的验证步骤（`tui-command-handlers.ts:878-935`）同样方式。

### 3. 测试文件

更新 `loop-validation.test.ts` 新增：
- `buildSpawnedVerifyPrompt` 包含 verdict 标记
- 验证 prompt 不包含 `loop_update` 引用

## 数据流

```
TUI Handler
  │
  ├─ sessions.create({ key: "...", agentId, message: verifyPrompt })
  │    └─ gateway 创建 session + 启动 run (异步)
  │
  ├─ 轮询 sessions.get({ key }) 直到出现 assistant 消息
  │    └─ assistant 回复包含 "---VERDICT---\npassed: true/false"
  │
  ├─ 解析 verdict
  │    └─ { passed, summary } ← 作为验证结果
  │
  ├─ sessions.delete({ key }) ← 清理
  │
  └─ TUI 更新 loop state: subtask.status + subtask.verdict
```

## 验证 agent 的隔离程度

| 维度 | 旧方案 | 新方案 |
|------|--------|--------|
| Conversation 历史 | 同一会话，见过执行代码 | **全新会话，零上下文** |
| 工具可访问性 | 全量 agent 工具 | 全量 agent 工具（含真实 `pnpm test` 权限） |
| 认知偏差 | 倾向于说自己写的好 | **无偏差，从零审视** |
| 结果传输 | loop_update → 模块状态 | **回复文本解析** |
