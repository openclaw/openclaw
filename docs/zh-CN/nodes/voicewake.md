---
read_when:
  - 更改语音唤醒词行为或默认值
  - 添加需要唤醒词同步的新节点平台
summary: 全局语音唤醒词（Gateway网关拥有）及其在节点间的同步方式
title: 语音唤醒
x-i18n:
  generated_at: "2026-02-01T21:19:01Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: eb34f52dfcdc3fc1ae088ae1f621f245546d3cf388299fbeea62face61788c37
  source_path: nodes/voicewake.md
  workflow: 15
---

# 语音唤醒（全局唤醒词）

OpenClaw 将**唤醒词视为由 Gateway网关拥有的单一全局列表**。

- **没有按节点自定义的唤醒词**。
- **任何节点/应用界面均可编辑**该列表；更改由 Gateway网关持久化并广播给所有人。
- 每个设备仍保留自己的**语音唤醒 启用/禁用**开关（本地用户体验和权限各异）。

## 存储（Gateway网关主机）

唤醒词存储在 Gateway网关机器上：

- `~/.openclaw/settings/voicewake.json`

结构：

```json
{ "triggers": ["openclaw", "claude", "computer"], "updatedAtMs": 1730000000000 }
```

## 协议

### 方法

- `voicewake.get` → `{ triggers: string[] }`
- `voicewake.set`，参数 `{ triggers: string[] }` → `{ triggers: string[] }`

说明：

- 触发词会被规范化（去除空白、丢弃空值）。空列表会回退到默认值。
- 出于安全考虑，会强制执行限制（数量/长度上限）。

### 事件

- `voicewake.changed` 载荷 `{ triggers: string[] }`

接收方：

- 所有 WebSocket 客户端（macOS 应用、WebChat 等）
- 所有已连接的节点（iOS/Android），节点连接时也会作为初始"当前状态"推送。

## 客户端行为

### macOS 应用

- 使用全局列表来控制 `VoiceWakeRuntime` 触发词。
- 在语音唤醒设置中编辑"触发词"会调用 `voicewake.set`，然后依赖广播保持其他客户端同步。

### iOS 节点

- 使用全局列表进行 `VoiceWakeManager` 触发词检测。
- 在设置中编辑唤醒词会调用 `voicewake.set`（通过 Gateway网关 WS），同时保持本地唤醒词检测的即时响应。

### Android 节点

- 在设置中提供唤醒词编辑器。
- 通过 Gateway网关 WS 调用 `voicewake.set`，使编辑在所有设备间同步。
