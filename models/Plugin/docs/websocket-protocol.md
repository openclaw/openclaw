# WebSocket 消息协议参考

本文档说明查看器与 WebSocket 桥接服务器之间的完整消息协议。

## 连接端点

```
ws://127.0.0.1:9877        WebSocket 连接
http://127.0.0.1:9877/status   HTTP 状态查询
```

## 消息格式

所有消息均为 UTF-8 编码的 JSON 字符串，顶层必须有 `cmd` 字段。

---

## 查看器 → 桥接服务器

### register（注册）

查看器连接后**立即**发送，声明机器人类型和实例标识。

```json
{
  "cmd": "register",
  "robotId": "abb-crb-15000",
  "instanceId": "tab-uuid-1234"
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|:----:|------|
| `robotId` | string | Y | 机器人配置 ID，与 `robots/*.json` 文件名对应 |
| `instanceId` | string | Y | 查看器唯一标识（建议用 tab UUID 或时间戳） |

### joints（关节状态回报）

响应 `get_joints` 命令时发送，也可主动推送。

```json
{
  "cmd": "joints",
  "joints": [0.0, -30.0, 60.0, 0.0, 30.0, 0.0]
}
```

### ok（操作确认）

```json
{ "cmd": "ok" }
```

---

## 桥接服务器 → 查看器

### registered（注册确认）

收到 `register` 后立即回复。

```json
{
  "cmd": "registered",
  "robotId": "abb-crb-15000",
  "instanceId": "tab-uuid-1234",
  "configFound": true,
  "manufacturer": "ABB",
  "model": "CRB 15000",
  "dof": 6,
  "totalConnected": 2,
  "knownRobots": ["abb-crb-15000"]
}
```

| 字段 | 说明 |
|------|------|
| `configFound` | true = 在 robots/ 目录找到匹配的 JSON 配置 |
| `totalConnected` | 当前桥接服务器管理的总连接数 |
| `knownRobots` | robots/ 目录中所有已知机器人 ID 列表 |

### set_joints（设置关节角度）

```json
{
  "cmd": "set_joints",
  "joints": [45.0, -30.0, 60.0, 0.0, 30.0, 0.0]
}
```

- `joints` 数组长度必须等于机器人 `dof`
- 所有值已在插件侧经过截断，保证在 `[min, max]` 范围内
- 查看器收到后应立即驱动模型运动，可选回复 `ok`

### home（回零位）

```json
{ "cmd": "home" }
```

所有关节回到配置文件中的 `home` 值（默认全部为 0.0）。

### get_joints（查询关节状态）

```json
{ "cmd": "get_joints" }
```

查看器应回复 `joints` 消息（含当前各关节角度）。

---

## HTTP /status 接口

```
GET http://127.0.0.1:9877/status
Content-Type: application/json
Access-Control-Allow-Origin: *
```

### 响应结构

```json
{
  "connected": [
    {
      "robotId": "abb-crb-15000",
      "instanceId": "tab-uuid-1234",
      "manufacturer": "ABB",
      "model": "CRB 15000",
      "dof": 6,
      "connectedAt": "2026-03-12T10:00:00.000Z",
      "lastSeen": "2026-03-12T10:05:30.000Z",
      "joints": [0.0, -30.0, 60.0, 0.0, 30.0, 0.0]
    }
  ],
  "knownRobots": ["abb-crb-15000"],
  "totalSessions": 1
}
```

---

## 路由规则

桥接服务器根据 MCP 工具调用参数确定发送目标：

| `robot_id` | `instance_id` | 路由目标 |
|:----------:|:-------------:|----------|
| 未指定 | 未指定 | 全部已连接查看器 |
| 指定 | 未指定 | 该 robotId 的全部实例 |
| 指定 | 指定 | 唯一特定实例 |

需要回复（如 `get_state`）时，取匹配列表中的**第一个**实例进行请求-响应；
广播命令（如 `set_joints`、`go_home`）同时发送给所有匹配实例。

---

## 回复等待机制

`sendToViewer()` 函数使用每会话回复队列（reply waiter queue）：

1. 发送命令时，将 `resolve` 回调注册到 `replyWaiters[sessionKey]`
2. 收到该会话的下一条消息时，弹出队列中最早的 `resolve` 并调用
3. 6 秒超时后自动 `reject`

火力即忘命令（`broadcastToRobot`）不注册回复等待，直接发送后返回。
