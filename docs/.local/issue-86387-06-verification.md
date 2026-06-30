# Issue #86387 — 验证结果

## 验证方式：真实 QQ Bot 运行日志

### 环境
- Gateway: pnpm dev gateway（production config）
- QQ Bot appId: 1903562876
- 源码: PR branch `fix/issue-86387-qqbot-route-guard` + route-persistence 日志注入
- 日志文件: `/tmp/openclaw/openclaw-2026-06-30.log`

### 测试结果

#### 1. C2C/DM 消息 → updateLastRoute 跳过 ✅

```
2026-06-30T20:17:31.661+08:00 [channels/qqbot] Processing message from sender ... type="c2c"
2026-06-30T20:17:31.924+08:00 [channels/qqbot] [route-persistence] inbound event.type=c2c isGroupChat=false -> omitting updateLastRoute
```

c2c 消息到达时 `isGroupChat=false`，`updateLastRoute` 被正确跳过。

#### 2. Group 消息 → updateLastRoute 应用 ✅

```
2026-06-30T20:18:02.415+08:00 [channels/qqbot] Processing message from sender ... type="group"
2026-06-30T20:18:02.422+08:00 [channels/qqbot] [route-persistence] inbound event.type=group isGroupChat=true -> applying updateLastRoute
```

group 消息到达时 `isGroupChat=true`，`updateLastRoute` 被正确应用。

### 结论

`inbound.isGroupChat` 门控逻辑在真实 QQ Bot 运行中表现正确：
- group/guild 消息 → 触发 route persistence
- c2c/dm 消息 → 不触发 route persistence
