# 链式任务看门狗（轻量版）

每天 21:30 执行。检查随机链式任务是否断链，优先做巡检；具备 cron 写能力时再补种子，不做内容生成/发布。

---

## 触发条件

- cron 触发（每天 21:30 Asia/Shanghai）
- 用户说“检查链式任务”“watchdog”

---

## 检查对象

| 链名                                           | 目标状态                                    | 备注                           |
| ---------------------------------------------- | ------------------------------------------- | ------------------------------ |
| Random PR Builder (one-shot chain)             | 次日白天 09:30-18:30 至少有 1 个未来任务    | 核心链，优先保证               |
| Random PR Conversation Patrol (one-shot chain) | 次日白天 10:00-18:00 至少有 1 个未来任务    | 核心链，优先保证               |
| Random Zhihu (one-shot chain)                  | 次日白天 09:30-18:30 至少有 1 个未来任务    | 仅在相关 skill/链路存在时补    |
| Random X Publish (one-shot chain)              | 若待发池非空，则次日白天至少有 1 个未来任务 | `x-posts/待发/*.md` 为空则不补 |
| Random XHS Publish (one-shot chain)            | 次日 17:00-19:00 至少有 1 个未来任务        | 仅在相关 skill/链路存在时补    |

---

## 执行流程

1. 先读取当前工作区是否存在 `x-posts/待发/*.md`。
2. 检查 `~/.openclaw/cron/jobs.json`（或等价 cron 列表）里的相关 job：
   - 是否 enabled
   - 是否存在未来 48 小时内的 `nextRunAtMs`
   - `deleteAfterRun: true` 的 one-shot 是否缺失/断链
   - `delivery` 是否缺 `to`（Feishu 常见断链点）
   - 是否存在明显错误 schedule（例如误写成按年执行）
3. 若运行环境具备 cron 写能力：
   - 对“应该继续但未来 48h 无 nextRun”的链补 1 个 one-shot 种子
   - `deleteAfterRun: true`
   - `sessionTarget: isolated`
   - `delivery` 必须明确写 `channel: "feishu"` + `to: "user:..."` 或 `chat:...`
4. 若当前运行环境**没有** cron 写能力：
   - 不编造“已补种子”
   - 明确报告哪些链正常、哪些断链、哪些因为条件不满足而跳过、哪些因权限/工具缺失而只能报告不能修
5. 只做最小修复，不做内容生成/发布。

---

## 高优先级断链信号

- 引用的 skill 文件不存在（例如 cron payload 指向缺失的 `skills/.../SKILL.md`）
- `delivery` 缺 `to`
- `Delivering to Feishu requires target <chatId|user:openId|chat:chatId>`
- one-shot chain 的 `schedule` 被写成异常远期/按年触发
- 需要续跑的链在未来 48 小时内没有 nextRun

---

## 回执格式

- 哪些链正常（有 nextRun）
- 哪些链断了 / 风险高（给出 job id + 原因）
- 哪些链因条件不满足而跳过（如 X 待发池为空）
- 哪些项理论上该补种子，但当前环境没有 cron 写能力，只能报告
