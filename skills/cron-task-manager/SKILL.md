---
name: cron-task-manager
description: Manage OpenClaw cron jobs through natural language. Use when the user wants to create, list, delete, or run scheduled tasks. Trigger phrases include: 'create a cron job', 'schedule a task', 'set a reminder', 'list my cron jobs', 'delete the cron job', 'run this task now', or any request involving scheduling, reminders, or timed tasks.
---

# Cron Task Manager

Manage OpenClaw cron jobs through natural language.

## Core Principles

**Never guess. Always confirm.** If any information is unclear, ask for clarification before creating the job.

## Workflow

### 1. Parse User Request

Extract the following from user's natural language:

- **Task content**: What should be executed
- **Schedule**: When to run (time, date, recurrence)
- **Session mode**: `isolated` (default) or `main`
- **Output channel**: Where to deliver results
- **Job type**: One-time (default) or recurring

### 2. Handle Ambiguity

If any field is unclear, ask clarifying questions:

**Time ambiguity:**

- "你说'晚上'，是指几点呢？比如 21:00 还是 22:00？"
- "'明天早上'是 8:00 还是 9:00？"

**Content ambiguity:**

- "你希望我在这个任务里具体做什么？能详细描述一下吗？"

**Session mode unclear:**

- "这个任务需要新开独立会话执行吗？（推荐，不会污染当前对话）"

**Output channel unclear:**

- "结果推送到飞书还是直接在这里显示？"

**Recurrence unclear:**

- "这是一次性任务还是每天/每周重复？"

### 3. Summarize and Auto-Create

Summarize the parsed intent and **immediately create the job**:

```
我理解的意图：
━━━━━━━━━━━━━━━━━
📋 任务：[任务描述]
⏰ 时间：[执行时间]
🎯 方式：[isolated/main]
📤 输出：[渠道]
🔄 类型：[一次性/周期性]
━━━━━━━━━━━━━━━━━

✅ 任务已自动创建！
🆔 任务ID：[id]

不需要的话回复"取消"或"删除"，我会立即删除该任务。
不回复则默认保留，任务将按计划执行。
```

**Do not wait for confirmation. Create the job immediately after summarizing.**

### 4. Handle Cancellation (Within 5 Minutes)

If user responds with cancellation intent ("取消", "删除", "不要了", "撤销") within 5 minutes:

1. Delete the job using the stored job ID
2. Confirm deletion: "✅ 任务已删除"

If user asks to modify ("改成", "改为", "换成"):

1. Delete the original job
2. Re-parse with new parameters
3. Create new job
4. Summarize again

### 5. Create the Job

Use `openclaw cron add` with parsed parameters:

```bash
openclaw cron add \
  --name "[job-name]" \
  --at "[ISO-time]" \
  --message "[task-content]" \
  --channel [feishu|terminal] \
  --to "[target]" \
  --session [isolated|main] \
  [--cron "[cron-expression]" for recurring]
```

For one-time jobs, add `--delete-after-run` flag.

### 5. Verify and Report

After creation, verify with `openclaw cron list` and report success:

```
✅ Cron 任务已创建！
━━━━━━━━━━━━━━━━━
📋 名称：[name]
⏰ 执行时间：[time]
🆔 ID：[id]
━━━━━━━━━━━━━━━━━
```

## Time Parsing Guidelines

### Natural Language → ISO Format

| Input           | Interpretation     | ISO Format                |
| --------------- | ------------------ | ------------------------- |
| "今晚9点"       | Today 21:00        | 2026-03-05T21:00:00+08:00 |
| "明天早上8点"   | Tomorrow 08:00     | 2026-03-06T08:00:00+08:00 |
| "30分钟后"      | Now + 30m          | Use duration syntax       |
| "每周一早上9点" | Every Monday 09:00 | cron="0 9 \* \* 1"        |
| "每天晚上10点"  | Daily 22:00        | cron="0 22 \* \* \*"      |

### Duration Syntax

For `openclaw cron add --at`:

- `+30m` - 30 minutes from now
- `+2h` - 2 hours from now
- `+1d` - 1 day from now

### Cron Expression Format

Use 5-field cron (minute hour day month weekday):

- `0 9 * * 1` - Every Monday at 9:00
- `0 22 * * *` - Daily at 22:00
- `0 */6 * * *` - Every 6 hours

## Other Operations

### List Jobs

```bash
openclaw cron list
```

Parse output and present in readable format.

### Delete Job

```bash
openclaw cron rm [job-id]
```

Or by name if user specifies:

```bash
openclaw cron list | grep [name]
# Then delete by ID
```

### Run Now

```bash
openclaw cron run [job-id]
```

## Error Handling

If `openclaw cron add` fails:

1. Capture error message
2. Explain the issue in plain language
3. Suggest fix or ask for clarification

Common errors:

- Invalid time format → Re-parse and retry
- Missing required fields → Ask user to provide
- Permission denied → Report to user

## Scripts

Use scripts in `scripts/` directory for reusable operations:

- `scripts/create-job.sh` - Wrapper for creating jobs with validation
- `scripts/list-jobs.sh` - Formatted job listing
- `scripts/delete-job.sh` - Safe job deletion with confirmation
- `scripts/run-now.sh` - Immediate execution
- `scripts/parse-time.py` - Natural language time parsing
