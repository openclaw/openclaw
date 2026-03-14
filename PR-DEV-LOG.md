# PR 开发日志：Control UI 实时消息同步

**分支**: `feat/chat-inbound-polling`
**开发时间**: 2026-03-14 09:00 - 16:15 (7+ 小时)
**开发者**: 诺亚(AI) + 奥克主人 + Claude Code(交叉验证)

---

## 目标

解决 OpenClaw Control UI 无法实时显示外部 channel（Telegram/Discord/Signal 等）入站消息的问题。用户在 Telegram 发消息后，必须手动刷新 Control UI 才能看到，体验很差。

## 最终方案

Gateway 侧注册 `message:received` internal hook → 广播 `chat.inbound` WebSocket 事件 → UI debounced `loadChatHistory`（二次刷新兜底）。同时在 UI 侧监听 `agent` event 的 `lifecycle.end`，agent 回复结束后再做一次 `loadChatHistory`，确保用户消息和 assistant 回复都完整显示。

## 改动文件

| 文件                                           | 改动    | 作用                                                                    |
| ---------------------------------------------- | ------- | ----------------------------------------------------------------------- |
| `src/gateway/server.impl.ts`                   | +32 行  | hook handler 注册（在 `startGatewaySidecars` 之后）、broadcast、cleanup |
| `src/gateway/server-methods-list.ts`           | +1 行   | `chat.inbound` 加入 GATEWAY_EVENTS 白名单                               |
| `src/auto-reply/reply/dispatch-from-config.ts` | 微调    | hook 触发点                                                             |
| `ui/src/ui/app-gateway.ts`                     | +40 行  | debounced 二次刷新 + chat.inbound handler + agent lifecycle.end 刷新    |
| `ui/src/ui/app-tool-stream.ts`                 | +15 行  | agent event 流式显示（assistant + thinking → chatStream）               |
| `src/gateway/chat-inbound-broadcast.test.ts`   | +142 行 | Gateway 侧 6 个单元测试                                                 |
| `src/gateway/chat-inbound-ui.test.ts`          | +108 行 | UI 侧 4 个单元测试                                                      |

---

## 踩过的坑（按时间顺序）

### 🔥 坑 1: 部署方式翻车（10:00-10:30）

**问题**: 最初直接把 `pnpm build` 产物覆盖到全局 `/opt/homebrew/lib/node_modules/openclaw/dist/`。

**连环事故**:

1. 只跑了 `pnpm build`（后端），没跑 `pnpm ui:build`（前端）→ Control UI 报 "assets not found"
2. 主人卸载重装 `npm install -g openclaw` 试图修复 → **`~/.openclaw/openclaw.json` 被重置为 18 行默认配置**
3. Telegram/Discord 所有 channel 配置全丢，Bot 完全断联
4. 从 `openclaw.json.bug-backup-*.json`（397 行）恢复才救回来

**教训**:

- `pnpm build` ≠ 完整构建，还需要 `pnpm ui:build`
- npm 重装会重置用户配置文件
- 开发了 `openclaw-dev.sh` 脚本（symlink 切换），避免直接覆盖全局目录

---

### 🔥 坑 2: 代码丢失，从零重写（10:30-11:00）

**问题**: 第一版代码写完后没 git commit，部署翻车时代码目录被 rename 成 backup，后来恢复后发现改动全丢。

**教训**: 写完代码立刻 commit，哪怕是 WIP 状态。

---

### 🔥 坑 3: `clearInternalHooks()` 时序问题（13:00-14:00）

**问题**: hook handler 注册了但从未被调用。debug `console.error` 放在 handler 第一行，完全没输出。

**排查过程**:

1. 诺亚误判为 bundler 跨 chunk 问题（`globalThis` key 不一致）→ ❌ 错误
2. Claude 纠正：key 完全一致，`__openclaw` 是 URL 路径常量不是 hook key
3. Claude 找到真正原因：`server.impl.ts` 的执行顺序——
   - 第 677 行: `registerInternalHook("message:received", handler)` — 注册
   - 第 936 行: `startGatewaySidecars()` → 内部调用 `clearInternalHooks()` → **注册被清除**
4. 修复：把注册移到 `startGatewaySidecars()` 之后（第 950 行）

**教训**:

- hook 注册要注意 clear/reset 的调用时序
- 不要猜测 bundler 行为，先用 debug 日志确认基本事实
- 交叉验证很有价值——一个 AI 的错误判断可以被另一个纠正

---

### 🔥 坑 4: 消息持久化时序（14:00-14:40）

**问题**: 修复坑 3 后，hook 正确触发、`chat.inbound` 成功广播到 UI，但 UI 刷新时**拉到的 history 里没有最新消息**。

**根因**: `dispatch-from-config.ts` 触发 hook 时，消息还没被持久化到 session history。完整路径：

1. `dispatch-from-config.ts` — hook 触发点（**太早**）
2. `getReplyFromConfig()`
3. `agent-runner.ts` — 进入 agent 队列
4. `attempt.ts` — `activeSession.prompt()`
5. Pi SessionManager `appendMessage()` — **消息才真正写入**

从 trigger 到持久化实测约 **3-9 秒**，而初始 debounce 只有 500ms。

**修复**: 采用二次刷新方案——

- 首次 500ms：乐观尝试（万一 agent 很快）
- 二次 3500ms（500+3000）：保证持久化完成后再拉一次

---

### 🔥 坑 5: Agent 回复不走 `chat` event（14:50-15:12）

**问题**: 用户消息通过 `chat.inbound` 实时同步成功 ✅，但 agent 回复在 UI 上不显示。

**排查**: 通过浏览器 DevTools → Network → WS Messages 面板发现，agent 回复只广播 `"event":"agent"`（含 `stream: "assistant"` delta 和 `stream: "lifecycle"` end），没有 `"event":"chat"`。方案 A（在 `handleChatGatewayEvent` 的 chat final 时触发 `loadChatHistory`）无效——因为 chat event 根本不存在。

**修复**: 在 `handleGatewayEventUnsafe` 的 agent event 处理块中，检测 `lifecycle.end`（`agentPayload.stream === "lifecycle" && agentPayload.data.phase === "end"`），触发 `loadChatHistory`。同时还原方案 A 的无效改动（恢复 `shouldReloadHistoryForFinalEvent` 条件）。

**验证**: 16:15 部署测试，用户消息 + agent 回复均实时同步到 Control UI ✅

---

### 🎯 坑 5 后续: Agent 流式显示（15:12-19:01）

**需求**: 用户在 Control UI 上只能看到最终结果一次性出现，看不到 agent 的思考过程和回复的逐字打出效果。

**分析**: `handleAgentEvent` 在 `app-tool-stream.ts` 第 408 行 `if (payload.stream !== "tool") return;` 直接丢弃了所有非 tool 的 stream，包括 `stream: "assistant"` 和 `stream: "thinking"`。而 `handleChatEvent` 依赖 `chat` event 更新 `chatStream`，但外部 channel 的 agent 回复不走 `chat` event。

**确认 data 格式**: 通过源码 `pi-embedded-subscribe.handlers.messages.ts` 确认：

- `data.text` = 累积全文（可直接赋值给 `chatStream`）
- `data.delta` = 增量文本

**修复**: 在 `app-tool-stream.ts` 的 `handleAgentEvent` 中，lifecycle/fallback 处理之后、tool 过滤之前，加入 `assistant` 和 `thinking` 的流式处理：

- 收到 `stream: "assistant"` 或 `stream: "thinking"` 且 `data.text` 存在时 → 更新 `host.chatStream`
- UI 实时渲染打字机效果
- `lifecycle.end` 时 `loadChatHistory` 做最终完整刷新

**验证**: 19:01 测试确认，回复逐字打出，思考内容实时可见 ✅

---

### 🔧 额外修复: `openclaw-dev.sh` 脚本问题

- `gateway_pids()` 匹配模式 `node.*openclaw.*gateway run` 过于严格，实际进程名是 `openclaw-gateway` → status 误报 Gateway 未运行
- `nohup openclaw gateway run` fallback 应改用 `launchctl kickstart`（系统用 LaunchAgent 管理 Gateway）

---

## 开发方法论

### 多 AI 交叉验证

本 PR 开发中使用了诺亚（主开发）+ Claude Code（review + debug）的双 AI 协作模式：

- **诺亚**: 负责初始设计、代码实现、测试编写
- **Claude Code**: 负责 code review、根因分析（找到了坑 3 和坑 4 的真正原因）
- **交叉验证的价值**: 诺亚误判 bundler 问题时，Claude 通过逐层验证 import chain 纠正了错误诊断

### 测试驱动

- Gateway 侧 6 个测试 + UI 侧 4 个测试
- 但实际部署测试暴露了单元测试无法覆盖的集成问题（时序、bundle、event routing）
- **教训**: hook 系统的测试必须包含集成测试（启动完整 Gateway），纯单元测试覆盖不了 `clearInternalHooks` 这类时序 bug

---

## 当前状态

| 功能                             | 状态                                                                         |
| -------------------------------- | ---------------------------------------------------------------------------- |
| Gateway `chat.inbound` broadcast | ✅ 工作正常                                                                  |
| UI 接收 `chat.inbound` 事件      | ✅ WS 确认                                                                   |
| 用户消息实时显示                 | ✅ ~3.5s 内出现                                                              |
| Agent 回复实时显示               | ✅ lifecycle.end 触发刷新                                                    |
| 流式打字效果                     | ✅ assistant + thinking 实时渲染                                             |
| 单元测试                         | ✅ 10/10 通过                                                                |
| debug 日志清理                   | ✅ 已清理（server.impl.ts log.info + dispatch-from-config.ts console.error） |
| 端到端验证                       | ✅ 19:01 Telegram → Control UI 实时同步 + 流式打字确认                       |

---

## 时间线

| 时间  | 事件                                                    |
| ----- | ------------------------------------------------------- |
| 09:00 | 开始开发，设计 WebSocket 事件方案                       |
| 10:00 | 部署翻车，`openclaw.json` 被重置                        |
| 10:30 | 写 `openclaw-dev.sh` 部署脚本                           |
| 11:00 | 代码从零重写（第一版丢失）                              |
| 11:30 | Claude Code review round 1-2                            |
| 12:00 | PR-REVIEW.md/PR-SUMMARY.md 从 git 移除                  |
| 13:00 | 首次部署测试——不工作                                    |
| 13:30 | 误判 bundler 问题，被 Claude 纠正                       |
| 13:55 | 找到真正 bug: `clearInternalHooks()` 时序               |
| 14:04 | 修复后 hook 正确触发（日志确认）                        |
| 14:25 | 发现消息持久化时序问题                                  |
| 14:37 | 二次刷新 3000ms 方案生效，用户消息实时同步 ✅           |
| 14:51 | 发现 agent 回复不走 `chat` event                        |
| 15:10 | 通过 WS Messages 确认只有 `agent` event                 |
| 15:15 | 设计 `lifecycle.end` → `loadChatHistory` 方案           |
| 16:15 | agent lifecycle.end 刷新方案验证通过                    |
| 17:10 | 提出流式显示需求，分析 assistant + thinking stream 格式 |
| 19:01 | 流式打字效果验证通过，全部功能完成 🎉                   |
