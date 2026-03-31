---
read_when:
  - 更改语音唤醒词行为或默认值
  - 添加需要唤醒词同步的新节点平台
summary: 全局语音唤醒词（Gateway 网关拥有）及其如何跨节点同步
title: 语音唤醒
x-i18n:
  generated_at: "2026-02-03T07:51:10Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: eb34f52dfcdc3fc1ae088ae1f621f245546d3cf388299fbeea62face61788c37
  source_path: nodes/voicewake.md
  workflow: 15
---

# 语音唤醒（全局唤醒词）

OpenClaw 将**唤醒词作为单一全局列表**，由 **Gateway 网关**拥有。

- **没有**每节点的自定义唤醒词。
- **任何节点/应用 UI 都可以编辑**列表；更改由 Gateway 网关持久化并广播给所有人。
- 每个设备仍保留自己的**语音唤醒启用/禁用**开关（本地用户体验 + 权限不同）。

## 存储（Gateway 网关主机）

唤醒词存储在 Gateway 网关机器上：

- `~/.openclaw/settings/voicewake.json`

结构：

```json
{ "triggers": ["openclaw", "claude", "computer"], "updatedAtMs": 1730000000000 }
```

## 协议

### 方法

- `voicewake.get` → `{ triggers: string[] }`
- `voicewake.set`，参数 `{ triggers: string[] }` → `{ triggers: string[] }`

注意事项：

- 触发词会被规范化（修剪空格、删除空值）。空列表回退到默认值。
- 为安全起见会强制执行限制（数量/长度上限）。

### 事件

- `voicewake.changed` 载荷 `{ triggers: string[] }`

接收者：

- 所有 WebSocket 客户端（macOS 应用、WebChat 等）
- 所有已连接的节点（iOS/Android），以及节点连接时作为初始"当前状态"推送。

## 客户端行为

### macOS 应用

- 使用全局列表来控制 `VoiceWakeRuntime` 触发器。
- 在语音唤醒设置中编辑"触发词"会调用 `voicewake.set`，然后依赖广播保持其他客户端同步。

### iOS 节点

- 使用全局列表进行 `VoiceWakeManager` 触发检测。
- 在设置中编辑唤醒词会调用 `voicewake.set`（通过 Gateway 网关 WS），同时保持本地唤醒词检测的响应性。

### Android 节点

- 在设置中暴露唤醒词编辑器。
- 通过 Gateway 网关 WS 调用 `voicewake.set`，使编辑在所有地方同步。
