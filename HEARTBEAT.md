# HEARTBEAT.md — Action Heartbeat Rules

> 每次心跳触发时，严格按以下顺序执行。不要推断或重复旧任务，只读本文件。

## 第一步：读取施工单

读取 `memory/heartbeat-state.json`，获取以下字段：

- `currentIssue`（当前正在做的 issue）
- `currentBranch`
- `lastCommitAt`
- `lastPrCreatedAt`
- `lastPrNumber`
- `lastActionHeartbeatAt`
- `inProgressFixes`

同时读取以下辅助文件：

- `memory/xixi-reports/latest-scan-report.md`（最新的 xixi 扫描报告）
- `memory/OPENCLAW-PROJECT.md`（当前追踪的 issue 池）

## 第二步：判断停滞（检测阶段）

### 检查 1：子任务是否失败

列出所有子任务 session（通过 sessions_list，filter `kinds=subagent`，recent 2h）。  
如果有任何 `status=failed` 或 `status=aborted` 的子任务：
→ 立即重派同一条任务（相同 issue，换一个模型如 `minimax/MiniMax-M2.5`），不要等。
→ 更新 `heartbeat-state.json` 的 `inProgressFixes`。

### 检查 2：xixi 扫描是否过期

读取 `lastXixiScanAt`（上次 xixi 扫描时间），如果超过 **1 小时**没有新扫描：
→ 通过 `sessions_spawn` 立即触发一次 xixi 全量扫描（runtime=subagent，agentId=xixi）。

### 检查 3：施工单是否过时

如果 `lastActionHeartbeatAt` 距今超过 **45 分钟**且 `inProgressFixes` 为空：
→ 说明上次心跳之后没有人继续推进，判定为停滞。
→ 从 `xixi-reports/latest-scan-report.md` 或 `OPENCLAW-PROJECT.md` 读取当前 Top candidate，直接通过 `sessions_spawn` 接单开始修复。

### 检查 4：commit / PR 是否停滞

如果 `lastCommitAt` 或 `lastPrCreatedAt` 距今超过 **2 小时**且没有活跃的 inProgressFixes：
→ 从 xixi 扫描报告读取下一个 Top candidate，直接接单。

## 第三步：执行（行动阶段）

如果以上任一检查触发行动：

1. 通过 `sessions_spawn` 派发修复任务（runtime=subagent，mode=run）
2. 等待子任务完成后，更新 `heartbeat-state.json`：
   - `currentIssue` → 刚完成的 issue 编号
   - `lastCommitAt` → 本次 commit 时间（如有）
   - `lastPrCreatedAt` → 本次 PR 时间（如有）
   - `lastActionHeartbeatAt` → 本次心跳时间（UTC ISO）
   - `lastActionHeartbeatResult` → 简要结果描述
   - `inProgressFixes` → 当前进展（如有）
   - `subagentFailures` → 追加失败的子任务记录
   - `subagentSuccesses` → 追加成功的子任务记录
3. 自动 git commit 记账（仅更新 state 文件，不推代码）：
   `git add memory/heartbeat-state.json && git commit -m "auto: heartbeat $(date -u +%Y-%m-%dT%H%M%SZ)"`

## 第四步：无行动

如果以上所有检查都通过（即：子任务无失败、xixi 未过期、施工单最新、无停滞）：
→ 输出简洁的 "No action needed right now."，不做任何变更。

## 关键原则

- **发现停滞 → 直接续跑或接下一条，不等用户回复。**
- **发现失败 → 立即换模型重派，不让情报流断掉。**
- **每轮心跳必须更新 `heartbeat-state.json`，即使什么都没做也要刷新 `lastActionHeartbeatAt`。**
- 禁止向任何聊天渠道发消息。
- 只在必要时 commit state 文件变化，不要每次都 commit。
