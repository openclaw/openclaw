# OpenClaw 升级后统一修复手册（Heartbeat + toolMsg + WebChat重复显示）

更新时间：2026-03-29 21:05 CST  
分析报告：`/tmp/openclaw-log-analysis-report-2026-03-29.md`

## 1. 官方状态（以 2026-03-29 检索结果为准）

| 项目                                                       | 官方仓库状态                                 | 是否写入脚本自动处理 |
| ---------------------------------------------------------- | -------------------------------------------- | -------------------- |
| Heartbeat 污染主会话（`agent:main:main` 被写成 heartbeat） | **未确认已官方发布修复到 2026.3.28**         | 是                   |
| `toolMsg.content.filter` 崩溃                              | **2026.3.28 仍可能触发**（依赖链中仍有风险） | 是                   |
| Web 端“输入一次显示两次/重复请求”                          | **仍有开放 issue**（见下方）                 | 是                   |
| skills symlink_escape 历史漏洞                             | **官方已修复（2026.2.25 后）**               | 否                   |

## 2. Web 端“输入一次显示两次”结论

### 2.1 你本机日志侧证据

- 当前主会话 jsonl 未稳定出现“后端双写”型重复（同一条 user 入库两次）。
- 但 `gateway.log` 存在高频 `webchat connected/disconnected`（重连风暴），会放大前端重试/重放问题。

### 2.2 官方仓库相关 issue（联网）

- [#28471 Webchat: missed messages after WebSocket reconnect (no catch-up mechanism)](https://github.com/openclaw/openclaw/issues/28471)（Open，2026-03-28 仍更新）
- [#56485 openclaw-control-ui: duplicate reflection requests and missing image attachment support](https://github.com/openclaw/openclaw/issues/56485)（Open，2026-03-28）
- [#24022 Control UI: previous message sometimes gets pasted into the next message (composer duplication)](https://github.com/openclaw/openclaw/issues/24022)（Open）

结论：这类问题在官方仓库仍属于活跃缺陷范围，不是你单机偶发错觉。

### 2.3 官方最佳实践（可执行）

1. 客户端重试必须复用同一个 `idempotencyKey`（不能每次重试生成新 key）。
2. 网关侧必须按 `idempotencyKey` 幂等处理（OpenClaw `chat.send` 已具备该能力）。
3. 前端要做 optimistic 消息去重（同一 `idempotencyKey` 只渲染一次）。
4. 重连后需要 history catch-up，避免“丢消息后人工重复发送”。

## 3. 三个文件当前整合内容

### 3.1 `~/Desktop/openclaw-reapply-heartbeat-fix.sh`

当前脚本会自动执行：

1. Heartbeat 污染修复（源码复打 + store 清理校验）
2. `toolMsg.content.filter` 自动检测、热修、复检
3. **WebChat 重复发送/重复显示防护补丁**（新增）
   - 在 UI 源码里把 queue/retry 路径改成复用同一 `runId/idempotencyKey`
   - 对 optimistic user message 增加 `idempotencyKey` 去重
   - 追加 UI 回归测试：`ui/src/ui/controllers/chat.test.ts`、`ui/src/ui/app-chat.test.ts`
4. Telegram 多 token 自动 `deleteWebhook`
5. 模型故障转移健康检查（primary/fallback/provider diversity）
6. Telegram/Discord retry 基线补齐（缺省时）
7. DNS 健康检查（`api.telegram.org` / `open.feishu.cn`）
8. 日志热点排序（新增 WebChat duplicate/reconnect 分类）

### 3.2 `~/Desktop/openclaw-safe-upgrade.sh`

当前脚本会自动执行：

1. 官方升级
2. 调用 `openclaw-reapply-heartbeat-fix.sh`
3. 二次校验：toolMsg、防故障转移、DNS
4. 日志热点摘要（含 WebChat duplicate/reconnect）
5. **新增 24 小时 WebChat 重复诊断**：
   - `webchat connected/disconnected` 次数
   - 当前主会话 transcript 的重复消息桶统计

## 4. 推荐执行

```bash
~/Desktop/openclaw-safe-upgrade.sh
# 或明确版本
~/Desktop/openclaw-safe-upgrade.sh 2026.3.28
```

## 5. 快速核验命令

### 5.1 Heartbeat 污染

```bash
node -e '
const fs=require("fs");
const p=process.env.HOME+"/.openclaw/agents/main/sessions/sessions.json";
const d=JSON.parse(fs.readFileSync(p,"utf8"));
const e=d["agent:main:main"];
console.log(JSON.stringify({
  polluted:e?.lastTo==="heartbeat"||e?.deliveryContext?.to==="heartbeat"||e?.origin?.provider==="heartbeat"
},null,2));
'
```

### 5.2 toolMsg/content.filter 防护

```bash
AGENT_LOOP="$(npm root -g)/openclaw/node_modules/@mariozechner/pi-agent-core/dist/agent-loop.js"
rg -n "message\.content\.filter\(\(c\)|assistantMessage\.content\.filter\(\(c\)|Array\.isArray\(message\.content\)|Array\.isArray\(assistantMessage\.content\)" "$AGENT_LOOP"
```

### 5.3 WebChat 重连风暴（最近24小时）

```bash
rg -n "\[ws\] webchat (connected|disconnected)" ~/.openclaw/logs/gateway.log ~/.openclaw/logs/gateway.err.log | tail -n 80
```

## 6. 备注

- 今天（2026-03-29）联网核对后，WebChat 重复显示相关问题仍有官方开放 issue。
- 因此该项已并入本地“升级后统一修复流程”，避免每次升级回归。
