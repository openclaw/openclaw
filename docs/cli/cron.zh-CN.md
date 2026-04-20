---
summary: "`openclaw cron`的CLI参考（调度和运行后台作业）"
read_when:
  - 您需要计划作业和唤醒
  - 您正在调试cron执行和日志
title: "cron"
---

# `openclaw cron`

管理Gateway调度器的cron作业。

相关：

- Cron作业：[Cron jobs](/automation/cron-jobs)

提示：运行`openclaw cron --help`查看完整的命令表面。

注意：隔离的`cron add`作业默认为`--announce`传递。使用`--no-deliver`保持输出内部。`--deliver`仍然作为`--announce`的已弃用别名。

注意：cron拥有的隔离运行期望一个纯文本摘要，并且运行器拥有最终的发送路径。`--no-deliver`保持运行内部；它不会将传递交还给代理的消息工具。

注意：一次性（`--at`）作业默认在成功后删除。使用`--keep-after-run`保留它们。

注意：`--session`支持`main`、`isolated`、`current`和`session:<id>`。使用`current`在创建时绑定到活动会话，或使用`session:<id>`获取显式持久会话密钥。

注意：对于一次性CLI作业，无偏移的`--at`日期时间被视为UTC，除非您还传递`--tz <iana>`，这会在给定的时区中解释本地挂钟时间。

注意：重复作业现在在连续错误后使用指数重试退避（30s → 1m → 5m → 15m → 60m），然后在下次成功运行后返回正常计划。

注意：`openclaw cron run`现在在手动运行排队执行后立即返回。成功的响应包括`{ ok: true, enqueued: true, runId }`；使用`openclaw cron runs --id <job-id>`跟踪最终结果。

注意：`openclaw cron run <job-id>`默认强制执行。使用`--due`保持较旧的"仅在到期时运行"行为。

注意：隔离的cron回合抑制陈旧的仅确认回复。如果第一个结果只是临时状态更新，且没有后代子代理运行负责最终答案，cron会在传递前再次提示真实结果。

注意：如果隔离的cron运行只返回静默令牌（`NO_REPLY` / `no_reply`），cron会抑制直接出站传递和回退排队摘要路径，因此不会将任何内容发布回聊天。

注意：`cron add|edit --model ...`对作业使用选定的允许模型。如果模型不被允许，cron会警告并回退到作业的代理/默认模型选择。配置的回退链仍然适用，但没有显式每作业回退列表的纯模型覆盖不再将代理主模型附加为隐藏的额外重试目标。

注意：隔离的cron模型优先级是Gmail-hook覆盖首先，然后是每作业`--model`，然后是任何存储的cron会话模型覆盖，然后是正常的代理/默认选择。

注意：隔离的cron快速模式遵循解析的实时模型选择。模型配置`params.fastMode`默认应用，但存储的会话`fastMode`覆盖仍然优先于配置。

注意：如果隔离运行抛出`LiveSessionModelSwitchError`，cron会在重试前持久化切换的提供者/模型（以及存在时切换的认证配置文件覆盖）。外部重试循环在初始尝试后限制为2次切换重试，然后中止而不是永远循环。

注意：失败通知首先使用`delivery.failureDestination`，然后使用全局`cron.failureDestination`，最后当没有配置显式失败目标时回退到作业的主要通知目标。

注意：保留/修剪由配置控制：

- `cron.sessionRetention`（默认`24h`）修剪已完成的隔离运行会话。
- `cron.runLog.maxBytes` + `cron.runLog.keepLines`修剪`~/.openclaw/cron/runs/<jobId>.jsonl`。

升级注意：如果您有来自当前传递/存储格式之前的旧cron作业，请运行`openclaw doctor --fix`。Doctor现在规范化遗留cron字段（`jobId`、`schedule.cron`、顶级传递字段包括遗留`threadId`、payload `provider`传递别名）并在配置了`cron.webhook`时将简单的`notify: true` webhook回退作业迁移到显式webhook传递。

## 常见编辑

更新传递设置而不更改消息：

```bash
openclaw cron edit <job-id> --announce --channel telegram --to "123456789"
```

禁用隔离作业的传递：

```bash
openclaw cron edit <job-id> --no-deliver
```

为隔离作业启用轻量级引导上下文：

```bash
openclaw cron edit <job-id> --light-context
```

向特定通道通知：

```bash
openclaw cron edit <job-id> --announce --channel slack --to "channel:C1234567890"
```

创建具有轻量级引导上下文的隔离作业：

```bash
openclaw cron add \
  --name "Lightweight morning brief" \
  --cron "0 7 * * *" \
  --session isolated \
  --message "Summarize overnight updates." \
  --light-context \
  --no-deliver
```

`--light-context`仅适用于隔离的代理回合作业。对于cron运行，轻量级模式保持引导上下文为空，而不是注入完整的工作区引导集。

传递所有权注意事项：

- Cron拥有的隔离作业总是通过cron运行器路由最终用户可见的传递（`announce`、`webhook`或内部仅`none`）。
- 如果任务提到向某些外部收件人发送消息，代理应该在其结果中描述预期的目的地，而不是尝试直接发送它。

## 常见管理命令

手动运行：

```bash
openclaw cron run <job-id>
openclaw cron run <job-id> --due
openclaw cron runs --id <job-id> --limit 50
```

代理/会话重定向：

```bash
openclaw cron edit <job-id> --agent ops
openclaw cron edit <job-id> --clear-agent
openclaw cron edit <job-id> --session current
openclaw cron edit <job-id> --session "session:daily-brief"
```

传递调整：

```bash
openclaw cron edit <job-id> --announce --channel slack --to "channel:C1234567890"
openclaw cron edit <job-id> --best-effort-deliver
openclaw cron edit <job-id> --no-best-effort-deliver
openclaw cron edit <job-id> --no-deliver
```

失败传递注意事项：

- `delivery.failureDestination`支持隔离作业。
- 主会话作业可能仅在主要传递模式为`webhook`时使用`delivery.failureDestination`。
- 如果您未设置任何失败目标且作业已经向通道通知，失败通知会重用相同的通知目标。
