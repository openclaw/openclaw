## 方案汇总

| 方案   | 核心思路                                                           | 推荐指数 |
| ------ | ------------------------------------------------------------------ | -------- |
| 方案 1 | 修复 `tui-event-handlers.ts` 中 `requestRender()` 的调用位置和时机 | ★★★★★    |
| 方案 2 | 修复 `ChatLog` 组件的 `streamingRuns` 状态管理和渲染触发           | ★★★★☆    |

### 推荐方案

基于评分，**方案 1** 更直接地针对问题的根本原因（渲染触发时机），改动更小且风险可控。

### 方案 1 详细内容

**问题根因**:
在 `handleChatEvent` 函数中，当 `ingestDelta` 返回 `null` 时函数提前返回，没有调用 `tui.requestRender()`，导致界面不更新。

**修复文件**: `src/tui/tui-event-handlers.ts`

**核心修改**:

1. 在 delta 状态处理中，即使没有新内容也调用 `tui.requestRender()`
2. 在成功更新助手消息后立即调用 `tui.requestRender()`
3. 确保 final 状态处理后总是触发渲染

### 方案 2 详细内容

**问题根因**:
`ChatLog` 组件的 `streamingRuns` Map 可能在某些情况下丢失对活动消息组件的跟踪，或者渲染触发机制有问题。

**修复文件**:

- `src/tui/components/chat-log.ts`
- `src/tui/tui-event-handlers.ts`

**核心修改**:

1. 改进 `ChatLog.updateAssistant` 方法的状态检查
2. 在消息更新时显式触发渲染
3. 添加调试日志帮助定位问题
