# 修复方案 1：TUI 消息显示问题分析

## 问题分析

Issue #35523: TUI doesn't display assistant messages until restart

### 根因定位

在分析 `src/tui/tui-event-handlers.ts` 中的 `handleChatEvent` 函数后，发现了渲染触发的问题：

```typescript
if (evt.state === "delta") {
  const displayText = streamAssembler.ingestDelta(evt.runId, evt.message, state.showThinking);
  if (!displayText) {
    return; // ⚠️ 提前返回，不会调用到底部的 tui.requestRender()
  }
  chatLog.updateAssistant(displayText, evt.runId);
  setActivityStatus("streaming");
  // ⚠️ 注意：这里没有立即调用 tui.requestRender()
}
// ... 其他状态处理
tui.requestRender(); // 只在函数最后调用
```

**问题1**: 当 `ingestDelta` 返回 `null` 时（表示没有新内容），函数提前返回，不会触发重新渲染。

**问题2**: 在 `delta` 状态成功更新消息后，没有立即请求渲染，而是依赖函数末尾的统一调用。这可能导致渲染延迟或丢失。

**问题3**: 在 `final` 状态处理中，某些代码路径（如 `suppressEmptyExternalPlaceholder`）调用 `chatLog.dropAssistant` 后，`tui.requestRender()` 可能没有被正确触发。

### 具体修复步骤

#### 文件1: `src/tui/tui-event-handlers.ts`

**修改1** - 在 delta 状态处理后确保渲染：

```typescript
if (evt.state === "delta") {
  const displayText = streamAssembler.ingestDelta(evt.runId, evt.message, state.showThinking);
  if (!displayText) {
    // 即使没有新内容，也可能需要渲染（比如思考内容的更新）
    tui.requestRender();
    return;
  }
  chatLog.updateAssistant(displayText, evt.runId);
  setActivityStatus("streaming");
  tui.requestRender(); // 立即请求渲染
  return; // 添加return避免重复渲染
}
```

**修改2** - 确保 final 状态总是触发渲染：

```typescript
if (evt.state === "final") {
  // ... existing code ...
  if (suppressEmptyExternalPlaceholder) {
    chatLog.dropAssistant(evt.runId);
  } else {
    chatLog.finalizeAssistant(finalText, evt.runId);
  }
  finalizeRun({...});
  tui.requestRender(); // 确保在return前调用
  return; // 明确返回
}
```

#### 文件2: `src/tui/components/chat-log.ts`

**修改** - 在 `updateAssistant` 方法中添加调试日志（可选）：

```typescript
updateAssistant(text: string, runId?: string) {
  const effectiveRunId = this.resolveRunId(runId);
  const existing = this.streamingRuns.get(effectiveRunId);
  if (!existing) {
    this.startAssistant(text, runId);
    return;
  }
  existing.setText(text);
}
```

### 验证步骤

1. 构建项目：`pnpm build`
2. 运行测试：`pnpm test src/tui/tui-event-handlers.test.ts`
3. 手动验证：
   - 启动 TUI：`node dist/cli/main.js tui`
   - 发送消息，观察助手回复是否立即显示
   - 测试多次对话，确保没有延迟或丢失

### 风险评估

| 风险             | 级别 | 缓解措施                               |
| ---------------- | ---- | -------------------------------------- |
| 过度渲染（性能） | 低   | 只在内容变化时渲染，且渲染是轻量级操作 |
| 渲染时序问题     | 低   | 保持原有渲染逻辑，只调整调用位置       |
| 测试回归         | 中   | 运行现有 TUI 测试套件确保通过          |

### 备选方案

如果上述修改不能完全解决问题，考虑：

1. 检查 `TuiStreamAssembler.ingestDelta` 的返回值逻辑
2. 检查 ChatLog 组件的 `streamingRuns` Map 状态管理
3. 添加更多的 `requestRender()` 调用点到网关事件处理中
