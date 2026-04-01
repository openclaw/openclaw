# PR #57579 现状分析报告

## 结论：当前 main 分支已无需代码修复

## 1. 消息体污染 ✅ 不存在

`sessions-send-tool.ts` 中 `sendParams.message` 直接透传用户原始消息，无任何文本前缀注入。
（grep `\[Metadata` 在两个文件中零匹配。）

## 2. Schema 违规（metadata 字段）✅ 不存在

`sendParams` 对象中无 `metadata` 字段，`AgentParamsSchema` 的 `additionalProperties: false` 不会被触发。
sender 身份完全通过 `inputProvenance` 结构化字段传递：

```ts
inputProvenance: {
  kind: "inter_session",
  sourceSessionKey: opts?.agentSessionKey,
  sourceChannel: opts?.agentChannel,
  sourceTool: "sessions_send",
}
```

## 3. A2A 全链路传递 ✅ 完整

### 初始调用（sessions-send-tool.ts L281-285）

| 字段             | 值                     | 状态 |
| ---------------- | ---------------------- | ---- |
| kind             | `"inter_session"`      | ✅   |
| sourceSessionKey | `opts.agentSessionKey` | ✅   |
| sourceChannel    | `opts.agentChannel`    | ✅   |
| sourceTool       | `"sessions_send"`      | ✅   |

### Ping-Pong 回复（sessions-send-tool.a2a.ts L96-99）

| 字段             | 值                           | 状态 |
| ---------------- | ---------------------------- | ---- |
| sourceSessionKey | `nextSessionKey`（动态切换） | ✅   |
| sourceChannel    | 根据当前回合动态切换         | ✅   |
| sourceTool       | `"sessions_send"`            | ✅   |

### Announce 步骤（sessions-send-tool.a2a.ts L127-129）

| 字段             | 值                           | 状态 |
| ---------------- | ---------------------------- | ---- |
| sourceSessionKey | `params.requesterSessionKey` | ✅   |
| sourceChannel    | `params.requesterChannel`    | ✅   |
| sourceTool       | `"sessions_send"`            | ✅   |

所有三条路径（initial / ping-pong / announce）均通过 `runAgentStep` 传递 `sourceSessionKey`、`sourceChannel`、`sourceTool`。

## 4. 测试覆盖 ✅ 已覆盖

- `src/gateway/server.sessions-send.test.ts` L145-150：验证 `inputProvenance` 包含正确的 `sourceTool: "sessions_send"`
- `inputProvenance` 在全项目中被 20+ 文件引用，是 Gateway 协议的标准字段

## 5. 无需改动

`inputProvenance` 已完整承载 sender 身份（sessionKey + channel + tool），无遗漏字段。
