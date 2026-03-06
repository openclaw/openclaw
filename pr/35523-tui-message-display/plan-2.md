# 修复方案 2：TUI 消息显示问题分析（替代视角）

## 问题分析

Issue #35523: TUI doesn't display assistant messages until restart

### 根因定位（替代视角）

从代码流和数据流的角度分析，发现了更深层的问题：

#### 问题1: 渲染时序与状态同步问题

在 `src/tui/components/chat-log.ts` 中：

```typescript
updateAssistant(text: string, runId?: string) {
  const effectiveRunId = this.resolveRunId(runId);
  const existing = this.streamingRuns.get(effectiveRunId);
  if (!existing) {
    // ⚠️ 如果runId不在streamingRuns中，会创建新组件
    this.startAssistant(text, runId);
    return;
  }
  existing.setText(text); // ⚠️ 只更新文本，不触发重渲染
}
```

`AssistantMessageComponent.setText()` 只更新了内部状态，但渲染是由 TUI 框架在 `requestRender()` 后异步执行的。

#### 问题2: 事件处理的竞态条件

在 `tui-event-handlers.ts` 中：

```typescript
const handleChatEvent = (payload: unknown) => {
  // ...
  if (evt.state === "delta") {
    const displayText = streamAssembler.ingestDelta(...);
    if (!displayText) {
      return; // ⚠️ 早期返回，没有渲染
    }
    chatLog.updateAssistant(displayText, evt.runId);
    setActivityStatus("streaming");
  }
  // ...
  tui.requestRender(); // ⚠️ 只在函数末尾调用
}
```

如果事件序列是：delta → delta → final，但前几个 delta 返回 null，可能导致渲染不及时。

#### 问题3: 初始消息创建问题

在 `chat-log.ts` 的 `startAssistant` 中：

```typescript
startAssistant(text: string, runId?: string) {
  const component = new AssistantMessageComponent(text);
  this.streamingRuns.set(this.resolveRunId(runId), component);
  this.append(component); // ⚠️ 添加到容器，但渲染可能延迟
  return component;
}
```

如果 `updateAssistant` 在 `startAssistant` 之后立即被调用，可能存在时序问题。

### 具体修复步骤

#### 方案A：确保每个状态变化都触发渲染

**文件**: `src/tui/tui-event-handlers.ts`

重构 `handleChatEvent` 函数，确保每个分支都正确触发渲染：

```typescript
const handleChatEvent = (payload: unknown) => {
  if (!payload || typeof payload !== "object") {
    return;
  }
  const evt = payload as ChatEvent;
  syncSessionKey();
  if (evt.sessionKey !== state.currentSessionKey) {
    return;
  }

  let shouldRender = false;

  if (finalizedRuns.has(evt.runId)) {
    if (evt.state === "delta" || evt.state === "final") {
      return; // 已完成的run，忽略后续事件
    }
  }

  noteSessionRun(evt.runId);
  if (!state.activeChatRunId) {
    state.activeChatRunId = evt.runId;
  }

  switch (evt.state) {
    case "delta": {
      const displayText = streamAssembler.ingestDelta(evt.runId, evt.message, state.showThinking);
      if (displayText) {
        chatLog.updateAssistant(displayText, evt.runId);
        setActivityStatus("streaming");
        shouldRender = true;
      }
      break;
    }
    case "final": {
      // ... 处理 final 状态
      shouldRender = true;
      break;
    }
    case "aborted":
    case "error": {
      // ... 处理中断和错误
      shouldRender = true;
      break;
    }
  }

  if (shouldRender) {
    tui.requestRender();
  }
};
```

#### 方案B：修复 ChatLog 的状态管理

**文件**: `src/tui/components/chat-log.ts`

添加调试日志以帮助诊断问题：

```typescript
updateAssistant(text: string, runId?: string) {
  const effectiveRunId = this.resolveRunId(runId);
  const existing = this.streamingRuns.get(effectiveRunId);
  if (!existing) {
    console.log(`[ChatLog] Creating new assistant component for runId: ${effectiveRunId}`);
    this.startAssistant(text, runId);
    return;
  }
  console.log(`[ChatLog] Updating assistant text for runId: ${effectiveRunId}`);
  existing.setText(text);
}
```

#### 方案C：检查 stream assembler 的返回值

**文件**: `src/tui/tui-stream-assembler.ts`

修改 `ingestDelta` 确保即使内容相同也返回有意义的值：

```typescript
ingestDelta(runId: string, message: unknown, showThinking: boolean): string | null {
  const state = this.getOrCreateRun(runId);
  const previousDisplayText = state.displayText;
  this.updateRunState(state, message, showThinking, {
    boundaryDropMode: "streamed-or-incoming",
  });

  // 修改：即使没有新文本，如果有思考内容也返回
  if (!state.displayText) {
    return null;
  }

  // 修改：如果文本相同但正在流式传输，仍然返回
  if (state.displayText === previousDisplayText && !state.thinkingText) {
    return null;
  }

  return state.displayText;
}
```

### 推荐方案

**主要采用方案A**，因为：

1. 它重构了事件处理逻辑，使渲染触发更明确
2. 使用 switch 语句替代多个 if，代码更清晰
3. 每个状态分支独立控制渲染标志，减少遗漏

**辅助方案B的调试日志**，在开发阶段帮助验证修复效果。

### 验证步骤

1. 单元测试：`pnpm test src/tui/tui-event-handlers.test.ts`
2. 集成测试：手动启动 TUI 进行多轮对话测试
3. 回归测试：确保工具事件、生命周期事件等正常

### 风险评估

| 风险           | 级别 | 说明                                   |
| -------------- | ---- | -------------------------------------- |
| 重构引入新问题 | 中   | 使用了 switch 重构，需测试所有事件类型 |
| 性能影响       | 低   | 渲染触发逻辑没有本质改变               |
| 向后兼容       | 高   | 只调整内部实现，不影响 API             |
